/* eslint-disable no-unused-vars */
interface Window {
    sse: {
        poster?: HTMLImageElement,
        settings: Promise<object>,
        contentUrl: string,
        contents: ArrayBuffer,
        params: Record<string, string>
    }

    firstFrame?: () => void;

    scrubTo?: (time: number) => Promise<void>;

    captureFrame?: (options?: { time?: number; width?: number; height?: number; supersample?: number }) => Promise<{ width: number; height: number; data: string }>;

    animationDuration?: number;

    getCameraState?: () => {
        position: [number, number, number];
        angles: [number, number, number];
        distance: number;
        fov: number;
        mode: 'orbit' | 'anim' | 'fly' | 'walk';
    };

    setCameraState?: (snapshot: {
        position: [number, number, number];
        angles: [number, number, number];
        distance: number;
        fov: number;
        mode: 'orbit' | 'anim' | 'fly' | 'walk';
    }) => void;

    __interlinkQA?: {
        ready: () => boolean;
        pose: () => import('./src/qa-harness').Pose;
        step: (ticks: number, input?: import('./src/qa-harness').StepInput) => import('./src/qa-harness').Sample[];
        navigate: (x: number, y: number, z: number, maxTicks?: number) => {
            trace: import('./src/qa-harness').Sample[];
            completed: boolean;
        };
        resetToSpawn: () => void;
        release: () => void;
    };
}

declare module 'playcanvas/scripts/esm/xr/xr-controllers.mjs' {
    const XrControllers: any;
    export { XrControllers };
}

declare module 'playcanvas/scripts/esm/xr/xr-navigation.mjs' {
    const XrNavigation: any;
    export { XrNavigation };
}

declare module '*.html' {
    const content: string;
    export default content;
}

declare module '*.css' {
    const content: string;
    export default content;
}

declare module '*.js' {
    const content: string;
    export default content;
}
