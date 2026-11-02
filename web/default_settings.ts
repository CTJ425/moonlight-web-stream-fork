import { Settings } from "./component/settings_menu.js"
import CONFIG from "./config.js"
import { StreamKeys } from "./api_bindings.js"

const trueDefaultSettings: Settings =

// When updated, update the README
{
    // possible values: "left", "right", "up", "down"
    "sidebarEdge": "left",
    "bitrate": 10000,
    "fps": 60,
    "videoFrameQueueSize": 3,
    // possible values: "720p", "1080p", "1440p", "4k", "native", "custom"
    "videoSize": "custom",
    // only works if videoSize=custom
    "videoSizeCustom": {
        "width": 1920,
        "height": 1080
    },
    // possible values: "h264", "h265", "av1", "auto"
    "videoCodec": "h264",
    "forceVideoElementRenderer": false,
    "canvasRenderer": false,
    // Canvas only: when true, draw only on requestAnimationFrame (stable, may add ~0–17 ms). When false, draw on frame submit (low latency).
    "canvasVsync": false,
    "playAudioLocal": false,
    "audioSampleQueueSize": 20,
    // possible values: "highres", "normal"
    "mouseScrollMode": "highres",
    // possible values: "relative", "follow", "pointAndDrag"
    "mouseMode": "follow",
    // possible values: "touch", "mouseRelative", "localCursor", "pointAndDrag"
    "touchMode": "mouseRelative",
    "localCursorSensitivity": 1,
    // On-screen stick (arrow keys) and buttons, only shown on touch devices
    // MapleStory's default keys, side scrollers use the arrow keys instead of a controller
    "touchControls": {
        "enabled": true,
        "buttons": [
            { "label": "攻擊", "key": StreamKeys.VK_LCONTROL },
            { "label": "跳", "key": StreamKeys.VK_LMENU },
            { "label": "撿取", "key": StreamKeys.VK_KEY_Z },
            { "label": "對話", "key": StreamKeys.VK_SPACE },
            { "label": "技能1", "key": StreamKeys.VK_LSHIFT },
            { "label": "技能2", "key": StreamKeys.VK_INSERT },
        ]
    },
    "controllerConfig": {
        "invertAB": false,
        "invertXY": false,
        // possible values: null or a number, example: 60, 120
        "sendIntervalOverride": null
    },
    // possible values: "auto", "webrtc", "websocket"
    "dataTransport": "auto",
    "language": "en",
    "enterFullscreenOnStreamStart": false,
    "toggleFullscreenWithKeybind": false,
    // possible values: "standard", "old"
    "pageStyle": "standard",
    "hdr": false,
    "useSelectElementPolyfill": false
}

export default trueDefaultSettings as Settings
