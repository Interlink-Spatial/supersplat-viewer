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

    const sample = (tick: number): Sample => {
        const { camera } = viewer.cameraManager!;
        return {
            tick,
            position: [camera.position.x, camera.position.y, camera.position.z],
            angles: [camera.angles.x, camera.angles.y, camera.angles.z]
        };
    };

    const ready = (): boolean => !!viewer.cameraManager && !!viewer.inputController;

    const step = (ticks: number, input: StepInput = {}): Sample[] => {
        if (!ready()) {
            throw new Error('__interlinkQA.step: viewer not ready');
        }
        viewer.qaPaused = true;
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

        navTarget.set(x, y, z);
        events.fire('navigateTo', navTarget, navNormal, 1);

        const trace: Sample[] = [];
        // eslint-disable-next-line no-unmodified-loop-condition
        for (let i = 0; i < maxTicks && !completed; i++) {
            viewer.stepFixed(FIXED_DT);
            trace.push(sample(i));
        }

        events.off('navigateComplete', onComplete);
        return { trace, completed };
    };

    const resetToSpawn = () => {
        events.fire('navigateCancel');
        viewer.qaPaused = false;
    };

    const release = () => {
        viewer.qaPaused = false;
    };

    (window as any).__interlinkQA = { ready, pose: () => sample(0), step, navigate, resetToSpawn, release };
};

export { registerQaHarness };
export type { Sample, StepInput };
