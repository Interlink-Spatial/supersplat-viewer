import { Vec3 } from 'playcanvas';

import type { CameraManager } from './camera-manager';
import type { CameraMode, Global } from './types';
import type { Viewer } from './viewer';

// Interlink camera-sync bridge.
//
// Preserves the interlink-app embed postMessage protocol so LiveKit guided
// tours can observe and drive this viewer's camera:
//
//   outbound:  interlink:camera-moved  { splat, pose: { position, target } }  (~15 Hz)
//              interlink:user-input    { active }                             (100 ms idle debounce)
//              interlink:mode-changed  { splat, mode, rawMode, walkAllowed }   on every change, and once
//                                                                              when the scene has loaded
//              interlink:rail-ended    {}                       a rail ended without rail-end: local
//                                                               input or a mode change took the camera
//   inbound:   interlink:set-camera    { pose }                 snap
//              interlink:fly-to        { pose, duration? }      animated flight (emits during flight)
//              interlink:ease-camera   { pose }                 damped follow; local input wins
//              interlink:follow        { pose, lookLimit? }     guided-tour follow: stand at the
//                                                               guide's position; local input only
//                                                               looks around, within lookLimit
//                                                               { yaw, pitch } degrees either side
//                                                               of the guide's facing (default
//                                                               ±90 / ±75). lookLimit.resync (s)
//                                                               recentres a guest who has stopped
//                                                               looking; a moving guide always does.
//                                                               Local input never cancels it; a
//                                                               follow sent before the scene loads
//                                                               is applied once it does.
//              interlink:unfollow      {}                       hand the camera back to local input
//              interlink:rail          { pose }                 flythrough: ride a path the host
//                                                               computes, one pose per host frame, in
//                                                               fly mode with collision out of the
//                                                               loop. Emits camera-moved throughout.
//              interlink:rail-end      {}                       stop where the camera is
//              interlink:set-mode      { mode }                 orbit | fly | walk (walk only where
//                                                               the scene is walkable)
//
// Enabled when `config.interlink.splatId` is set. Registered from main()
// after the Viewer is constructed; the camera manager only exists once the
// scene has loaded, so all access is guarded.

type Pose = { position: [number, number, number]; target: [number, number, number] };

const poseVec = new Vec3();
const targetVec = new Vec3();

const registerInterlinkBridge = (global: Global, viewer: Viewer) => {
    const { app, config, events, state } = global;
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
    const postMode = (mode: CameraMode) => {
        post({
            type: 'interlink:mode-changed',
            splat: splatId,
            mode: mapMode(mode),
            rawMode: mode,
            walkAllowed: state.walkAllowed
        });
    };
    events.on('cameraMode:changed', postMode);

    // The opening mode is set while the camera manager is constructed, before
    // a host page could be told about it; announce it once the scene is up.
    let announced = false;
    app.on('update', () => {
        if (!announced && viewer.cameraManager) {
            announced = true;
            postMode(state.cameraMode);
        }
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

    type LookLimit = { yaw?: number; pitch?: number; resync?: number };
    type FollowRequest = { pose: Pose; lookLimit?: LookLimit };

    const followPos = new Vec3();
    const followTarget = new Vec3();
    const applyFollow = (manager: CameraManager, request: FollowRequest) => {
        const { position, target } = request.pose;
        followPos.set(position[0], position[1], position[2]);
        followTarget.set(target[0], target[1], target[2]);
        const yaw = request.lookLimit?.yaw;
        const pitch = request.lookLimit?.pitch;
        const resync = request.lookLimit?.resync;
        manager.follow(
            followPos,
            followTarget,
            typeof yaw === 'number' ? yaw : undefined,
            typeof pitch === 'number' ? pitch : undefined,
            typeof resync === 'number' ? resync : undefined
        );
    };

    // The guide may be standing still when a guest's scene finishes
    // loading, so no fresh pose would arrive to start the follow; the
    // latest request is kept until the camera manager exists.
    let pendingFollow: FollowRequest | null = null;
    app.on('update', () => {
        if (pendingFollow && viewer.cameraManager) {
            applyFollow(viewer.cameraManager, pendingFollow);
            pendingFollow = null;
        }
    });

    const setFollowing = (on: boolean) => {
        // hides the camera-mode buttons, which mean nothing while following
        document.body.classList.toggle('interlink-follow', on);
    };

    // --- outbound: a rail the host did not end ---

    // Local input and mode changes take the camera off a rail inside the
    // camera manager; the host is told so its play control can follow.
    let railRequested = false;
    app.on('update', () => {
        if (railRequested && viewer.cameraManager && !viewer.cameraManager.railing) {
            railRequested = false;
            post({ type: 'interlink:rail-ended', splat: splatId });
        }
    });

    window.addEventListener('message', (event: MessageEvent) => {
        const data = (event.data ?? {}) as {
            type?: string;
            pose?: Pose;
            duration?: number;
            lookLimit?: LookLimit;
            mode?: string;
        };
        const manager = viewer.cameraManager;

        if (data.type === 'interlink:rail-end') {
            railRequested = false;
            manager?.endRail();
            return;
        }
        if (data.type === 'interlink:set-mode') {
            const { mode } = data;
            if (manager && !manager.following &&
                (mode === 'orbit' || mode === 'fly' || (mode === 'walk' && state.walkAllowed))) {
                state.cameraMode = mode;
            }
            return;
        }

        if (data.type === 'interlink:follow' && data.pose) {
            setFollowing(true);
            if (manager) {
                applyFollow(manager, { pose: data.pose, lookLimit: data.lookLimit });
            } else {
                pendingFollow = { pose: data.pose, lookLimit: data.lookLimit };
            }
            return;
        }
        if (data.type === 'interlink:unfollow') {
            setFollowing(false);
            pendingFollow = null;
            manager?.unfollow();
            return;
        }

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
            case 'interlink:rail':
                manager.rail(poseVec, targetVec);
                railRequested = manager.railing;
                break;
        }
    });
};

export { registerInterlinkBridge };
