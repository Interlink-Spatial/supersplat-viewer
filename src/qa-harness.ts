import { Vec3 } from 'playcanvas';

import type { CameraMode, Global } from './types';
import type { Viewer } from './viewer';

// Deterministic walk-QA hook.
//
// The collision tune loop needs pose telemetry that depends only on the
// collision data and the input sequence — never on achieved frame rate.
// WalkController already integrates at a fixed 1/60 internally, so the only
// nondeterminism is that dt normally comes from the wall clock. This drives
// the same update path with a constant dt while the rAF loop is suspended.
//
// Enabled only when `config.qa` is set. Never present on visitor pages.

const FIXED_DT = 1 / 60;

type Sample = {
    tick: number;
    position: [number, number, number];
    angles: [number, number, number];
};

type Pose = Omit<Sample, 'tick'>;

type StepInput = {
    move?: [number, number, number];
    rotate?: [number, number, number];
};

const navNormal = new Vec3(0, 1, 0);
const navTarget = new Vec3();

const registerQaHarness = (global: Global, viewer: Viewer) => {
    const { config, events, state } = global;
    if (!config.qa) {
        return;
    }

    // Lets the harness assert it's actually in walk mode before probing,
    // instead of pressing '3' blindly. '3' fires toggleWalk, which toggles
    // walk on OR off depending on the current mode — if the scene's initial
    // camera already sits in walk (e.g. inside the bbox), a blind '3'
    // exits to fly instead of entering walk.
    const mode = (): CameraMode => state.cameraMode;

    const pose = (): Pose => {
        const { camera } = viewer.cameraManager!;
        return {
            position: [camera.position.x, camera.position.y, camera.position.z],
            angles: [camera.angles.x, camera.angles.y, camera.angles.z]
        };
    };

    const sample = (tick: number): Sample => ({ tick, ...pose() });

    const ready = (): boolean => !!viewer.cameraManager && !!viewer.inputController;

    const step = (ticks: number, input: StepInput = {}): Sample[] => {
        if (!ready()) {
            throw new Error('__interlinkQA.step: viewer not ready');
        }
        viewer.qaPaused = true;
        try {
            const { frame } = viewer.inputController!;
            const trace: Sample[] = [];
            for (let i = 0; i < ticks; i++) {
                if (input.move) {
                    frame.deltas.move.append(input.move);
                }
                if (input.rotate) {
                    frame.deltas.rotate.append(input.rotate);
                }
                viewer.stepFixed(FIXED_DT);
                trace.push(sample(i));
            }
            return trace;
        } catch (err) {
            // Leave the caller a recoverable viewer instead of a permanently
            // paused rAF loop; qaPaused otherwise stays true across step()
            // calls by design, so only clear it on this failure path.
            viewer.qaPaused = false;
            throw err;
        }
    };

    const navigate = (x: number, y: number, z: number, maxTicks = 1800) => {
        if (!ready()) {
            throw new Error('__interlinkQA.navigate: viewer not ready');
        }
        viewer.qaPaused = true;

        let completed = false;
        const onComplete = () => {
            completed = true;
        };
        events.on('navigateComplete', onComplete);

        try {
            navTarget.set(x, y, z);
            events.fire('navigateTo', navTarget, navNormal, 1);

            const trace: Sample[] = [];
            // `completed` is mutated synchronously inside viewer.stepFixed():
            // cameraManager.update() -> walkSource.update() -> cancel() ->
            // onComplete() -> events.fire('navigateComplete') -> onComplete()
            // above, all within this same call stack frame. PlayCanvas's
            // EventHandler.fire() is synchronous, so the flag is observed on
            // the same tick it's set; ESLint just can't trace a mutation made
            // through a transitively-invoked callback, hence the disable.
            // eslint-disable-next-line no-unmodified-loop-condition
            for (let i = 0; i < maxTicks && !completed; i++) {
                viewer.stepFixed(FIXED_DT);
                trace.push(sample(i));
            }

            return { trace, completed };
        } catch (err) {
            // See step() above: clear the pause only on failure, never on
            // normal completion.
            viewer.qaPaused = false;
            throw err;
        } finally {
            events.off('navigateComplete', onComplete);
        }
    };

    // Steps the simulation to completion of whatever navigation is already
    // in flight, without firing a new `navigateTo`. Callers that pick a
    // world-space target themselves (e.g. a raycast off a real mouse click)
    // use this instead of navigate(), which would otherwise fire a second,
    // overriding `navigateTo` at the caller-supplied coordinates.
    const stepUntilIdle = (maxTicks = 1800) => {
        if (!ready()) {
            throw new Error('__interlinkQA.stepUntilIdle: viewer not ready');
        }
        viewer.qaPaused = true;

        let completed = false;
        const onComplete = () => {
            completed = true;
        };
        events.on('navigateComplete', onComplete);

        try {
            const trace: Sample[] = [];
            // See navigate() above: `completed` is mutated synchronously
            // inside viewer.stepFixed(), observed on the same tick it's set.
            // eslint-disable-next-line no-unmodified-loop-condition
            for (let i = 0; i < maxTicks && !completed; i++) {
                viewer.stepFixed(FIXED_DT);
                trace.push(sample(i));
            }

            return { trace, completed };
        } catch (err) {
            // See step() above: clear the pause only on failure, never on
            // normal completion.
            viewer.qaPaused = false;
            throw err;
        } finally {
            events.off('navigateComplete', onComplete);
        }
    };

    // camera-manager.ts's 'reset' handler starts a transition: transitionTimer
    // runs 0 -> 1 at `deltaTime * transitionSpeed` per update (transitionSpeed
    // is 1.0), and until it reaches 1 the displayed camera is a lerp() between
    // the pre-reset pose and the spawn target, not the target itself. Driven
    // at FIXED_DT (1/60) that's exactly 60 ticks (60 * 1/60 === 1.0 - verified
    // the float sum lands on precisely 1.0 at tick 60, not 59 or 61, so
    // Math.min's clamp never masks an early finish). The rAF loop is paused
    // during QA, so nothing else will ever advance that transition; a small
    // margin over the exact 60 covers the walk controller's own ground-spring
    // settling in the ticks right after resetToSpawn's teleport (harmless
    // no-ops once the camera has already arrived).
    const RESET_TRANSITION_TICKS = 65;

    const resetToSpawn = () => {
        viewer.qaPaused = true;

        // Cancel any in-flight auto-navigation across all modes first, then
        // drive the same 'reset' path the UI's reset button uses so the
        // camera actually returns to its spawn pose instead of halting where
        // an auto-walk happened to be interrupted.
        events.fire('navigateCancel');
        events.fire('inputEvent', 'reset');

        // Step the reset transition to completion ourselves - see
        // RESET_TRANSITION_TICKS above for why this is necessary while the
        // rAF loop is paused.
        for (let i = 0; i < RESET_TRANSITION_TICKS; i++) {
            viewer.stepFixed(FIXED_DT);
        }

        // Stay paused. resetToSpawn() and the harness's next call are two
        // separate Playwright evaluate() round trips; releasing the pause
        // here would let the rAF loop advance the camera with a real
        // wall-clock deltaTime in between, reintroducing exactly the
        // nondeterminism this harness exists to eliminate. Only release()
        // may clear it.
    };

    const release = () => {
        viewer.qaPaused = false;
    };

    window.__interlinkQA = { ready, mode, pose, step, navigate, stepUntilIdle, resetToSpawn, release };
};

export { registerQaHarness };
export type { Sample, Pose, StepInput };
