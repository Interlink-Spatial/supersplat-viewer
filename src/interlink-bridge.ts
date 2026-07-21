import { Vec3 } from 'playcanvas';

import type { CameraMode, Global } from './types';
import type { Viewer } from './viewer';

// Interlink camera-sync bridge.
//
// Preserves the interlink-app embed postMessage protocol so LiveKit guided
// tours can observe and drive this viewer's camera:
//
//   outbound:  interlink:camera-moved  { splat, pose: { position, target } }  (~15 Hz)
//              interlink:user-input    { active }                             (100 ms idle debounce)
//              interlink:mode-changed  { splat, mode, rawMode }
//   inbound:   interlink:set-camera    { pose }                 snap
//              interlink:fly-to        { pose, duration? }      animated flight (emits during flight)
//              interlink:ease-camera   { pose }                 damped follow; local input wins
//
// Enabled when `config.interlink.splatId` is set. Registered from main()
// after the Viewer is constructed; the camera manager only exists once the
// scene has loaded, so all access is guarded.

type Pose = { position: [number, number, number]; target: [number, number, number] };

const poseVec = new Vec3();
const targetVec = new Vec3();

const registerInterlinkBridge = (global: Global, viewer: Viewer) => {
    const { app, config, events } = global;
    const splatId = config.interlink?.splatId;
    if (!splatId) {
        return;
    }

    const post = (message: Record<string, unknown>) => {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage(message, '*');
        }
    };

    // --- outbound: camera pose (~15 Hz) ---

    let lastSent = 0;
    let suppressEmit = false;
    const lastPose = { px: NaN, py: NaN, pz: NaN, tx: NaN, ty: NaN, tz: NaN };

    app.on('update', () => {
        const manager = viewer.cameraManager;
        if (!manager || suppressEmit || manager.remoteEasing) {
            return;
        }
        const now = performance.now();
        if (now - lastSent < 66) {
            return;
        }
        const { camera } = manager;
        camera.calcFocusPoint(targetVec);
        const { position } = camera;
        if (position.x === lastPose.px && position.y === lastPose.py && position.z === lastPose.pz &&
            targetVec.x === lastPose.tx && targetVec.y === lastPose.ty && targetVec.z === lastPose.tz) {
            return;
        }
        lastSent = now;
        lastPose.px = position.x;
        lastPose.py = position.y;
        lastPose.pz = position.z;
        lastPose.tx = targetVec.x;
        lastPose.ty = targetVec.y;
        lastPose.tz = targetVec.z;
        post({
            type: 'interlink:camera-moved',
            splat: splatId,
            pose: {
                position: [position.x, position.y, position.z],
                target: [targetVec.x, targetVec.y, targetVec.z]
            }
        });
    });

    // --- outbound: camera mode ---

    // Existing tour consumers only understand 'orbit' | 'walk'; the raw
    // viewer mode rides along for future use.
    const mapMode = (mode: CameraMode) => (mode === 'walk' || mode === 'fly' ? 'walk' : 'orbit');
    events.on('cameraMode:changed', (mode: CameraMode) => {
        post({ type: 'interlink:mode-changed', splat: splatId, mode: mapMode(mode), rawMode: mode });
    });

    // --- outbound: user-input activity (gates guide soft-follow) ---

    const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
    let inputActive = false;
    let inputIdleTimer: number | undefined;
    const notifyInputStart = () => {
        if (inputIdleTimer !== undefined) {
            window.clearTimeout(inputIdleTimer);
            inputIdleTimer = undefined;
        }
        if (!inputActive) {
            inputActive = true;
            post({ type: 'interlink:user-input', active: true });
        }
    };
    const notifyInputEnd = () => {
        if (inputIdleTimer !== undefined) {
            window.clearTimeout(inputIdleTimer);
        }
        inputIdleTimer = window.setTimeout(() => {
            inputIdleTimer = undefined;
            if (inputActive) {
                inputActive = false;
                post({ type: 'interlink:user-input', active: false });
            }
        }, 100);
    };
    (['pointerdown', 'wheel', 'keydown', 'touchstart'] as const).forEach((name) => {
        canvas.addEventListener(name, notifyInputStart, { passive: true });
    });
    (['pointerup', 'pointercancel', 'keyup', 'touchend', 'touchcancel'] as const).forEach((name) => {
        canvas.addEventListener(name, notifyInputEnd, { passive: true });
    });

    // --- inbound: remote camera drive ---

    window.addEventListener('message', (event: MessageEvent) => {
        const data = (event.data ?? {}) as { type?: string; pose?: Pose; duration?: number };
        const manager = viewer.cameraManager;
        if (!manager || !data.pose) {
            return;
        }
        const { position, target } = data.pose;
        poseVec.set(position[0], position[1], position[2]);
        targetVec.set(target[0], target[1], target[2]);

        switch (data.type) {
            case 'interlink:set-camera':
                suppressEmit = true;
                manager.setPose(poseVec, targetVec);
                suppressEmit = false;
                break;
            case 'interlink:fly-to':
                manager.flyTo(poseVec, targetVec, typeof data.duration === 'number' ? data.duration : undefined);
                break;
            case 'interlink:ease-camera':
                manager.easeTo(poseVec, targetVec);
                break;
        }
    });
};

export { registerInterlinkBridge };
