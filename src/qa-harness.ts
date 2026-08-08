import { Vec3 } from 'playcanvas';

import type { Global } from './types';
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
    const { config, events } = global;
    if (!config.qa) {
        return;
    }

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

    const resetToSpawn = () => {
        // Cancel any in-flight auto-navigation across all modes first, then
        // drive the same 'reset' path the UI's reset button uses so the
        // camera actually returns to its spawn pose instead of halting where
        // an auto-walk happened to be interrupted.
        events.fire('navigateCancel');
        events.fire('inputEvent', 'reset');
        viewer.qaPaused = false;
    };

    const release = () => {
        viewer.qaPaused = false;
    };

    window.__interlinkQA = { ready, pose, step, navigate, resetToSpawn, release };
};

export { registerQaHarness };
export type { Sample, Pose, StepInput };
