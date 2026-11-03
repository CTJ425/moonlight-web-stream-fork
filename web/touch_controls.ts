import { StreamKeys } from "./api_bindings"

export type TouchControlButton = {
    label: string
    key: number
}

export type TouchControlsConfig = {
    enabled: boolean
    buttons: Array<TouchControlButton>
}

// Relative to the stick radius
const STICK_DEAD_ZONE = 0.3
// A horizontal drag must not crouch or climb by accident, so vertical needs a steeper angle: sin(22.5) and sin(35) degrees
const STICK_HORIZONTAL_THRESHOLD = 0.38
const STICK_VERTICAL_THRESHOLD = 0.57

export function stickKeys(x: number, y: number, radius: number): Array<number> {
    const distance = Math.hypot(x, y)
    if (distance < radius * STICK_DEAD_ZONE) {
        return []
    }

    const keys = []
    if (x / distance <= -STICK_HORIZONTAL_THRESHOLD) {
        keys.push(StreamKeys.VK_LEFT)
    } else if (x / distance >= STICK_HORIZONTAL_THRESHOLD) {
        keys.push(StreamKeys.VK_RIGHT)
    }
    if (y / distance <= -STICK_VERTICAL_THRESHOLD) {
        keys.push(StreamKeys.VK_UP)
    } else if (y / distance >= STICK_VERTICAL_THRESHOLD) {
        keys.push(StreamKeys.VK_DOWN)
    }
    return keys
}

export function streamKeyOptions(): Array<{ value: string, name: string }> {
    const keyList = []
    for (const keyNameRaw in StreamKeys) {
        const keyName = keyNameRaw as keyof typeof StreamKeys
        const keyValue = StreamKeys[keyName]

        const PREFIX = "VK_"

        let name: string = keyName
        if (name.startsWith(PREFIX)) {
            name = name.slice(PREFIX.length)
        }

        keyList.push({
            value: keyValue.toString(),
            name
        })
    }
    return keyList
}

export class TouchControls {
    private div = document.createElement("div")
    private toggleButton = document.createElement("button")
    private stick = document.createElement("div")
    private stickKnob = document.createElement("div")
    private buttonsDiv = document.createElement("div")

    private sendKey: (isDown: boolean, key: number) => void
    private onConfigChange: (config: TouchControlsConfig) => void
    private config: TouchControlsConfig
    private suspended: boolean = false

    private stickPointer: number | null = null
    private pressedStickKeys: Array<number> = []
    private pressedButtons: Map<number, { key: number, element: HTMLButtonElement }> = new Map()

    constructor(sendKey: (isDown: boolean, key: number) => void, toggleLabel: string, config: TouchControlsConfig, onConfigChange: (config: TouchControlsConfig) => void) {
        this.sendKey = sendKey
        this.config = config
        this.onConfigChange = onConfigChange

        this.div.classList.add("touch-controls")
        // The long press menu of mobile browsers would interrupt a held button
        this.div.addEventListener("contextmenu", event => event.preventDefault())
        this.div.addEventListener("touchstart", event => event.preventDefault(), { passive: false })

        this.toggleButton.type = "button"
        this.toggleButton.innerText = "🎮"
        this.toggleButton.title = toggleLabel
        this.toggleButton.ariaLabel = toggleLabel
        this.toggleButton.classList.add("touch-controls-toggle")
        this.toggleButton.addEventListener("pointerup", () => {
            this.setConfig({ ...this.config, enabled: !this.config.enabled })
        })
        this.div.appendChild(this.toggleButton)

        this.stick.classList.add("touch-controls-stick")
        this.stickKnob.classList.add("touch-controls-knob")
        this.stick.appendChild(this.stickKnob)
        this.stick.addEventListener("pointerdown", this.onStickDown.bind(this))
        this.stick.addEventListener("pointermove", this.onStickMove.bind(this))
        this.stick.addEventListener("pointerup", this.onStickUp.bind(this))
        this.stick.addEventListener("pointercancel", this.onStickUp.bind(this))
        this.div.appendChild(this.stick)

        this.buttonsDiv.classList.add("touch-controls-buttons")
        this.div.appendChild(this.buttonsDiv)

        this.rebuildButtons()
        this.updateVisibility()
    }

    getElement(): HTMLElement {
        return this.div
    }

    getConfig(): TouchControlsConfig {
        return this.config
    }
    setConfig(config: TouchControlsConfig) {
        this.releaseAll()
        this.config = config
        this.onConfigChange(config)
        this.rebuildButtons()
        this.updateVisibility()
    }

    // Hides the controls while something else like the sidebar needs the screen
    setSuspended(suspended: boolean) {
        this.suspended = suspended
        this.releaseAll()
        this.updateVisibility()
    }

    private updateVisibility() {
        this.div.classList.toggle("touch-controls-suspended", this.suspended)
        // Enabled means shown on touch devices, a mouse never needs the controls
        this.div.classList.toggle("touch-controls-active", this.config.enabled && window.matchMedia("(pointer: coarse)").matches)
    }

    private rebuildButtons() {
        this.buttonsDiv.replaceChildren()

        for (const { label, key } of this.config.buttons) {
            const element = document.createElement("button")
            element.type = "button"
            element.innerText = label
            element.classList.add("touch-controls-button")

            element.addEventListener("pointerdown", event => {
                event.preventDefault()
                element.setPointerCapture(event.pointerId)
                this.pressedButtons.set(event.pointerId, { key, element })
                element.classList.add("touch-controls-pressed")
                this.sendKey(true, key)
            })
            const onUp = (event: PointerEvent) => this.releaseButton(event.pointerId)
            element.addEventListener("pointerup", onUp)
            element.addEventListener("pointercancel", onUp)

            this.buttonsDiv.appendChild(element)
        }
    }

    private releaseButton(pointerId: number) {
        const pressed = this.pressedButtons.get(pointerId)
        if (!pressed) {
            return
        }

        this.pressedButtons.delete(pointerId)
        pressed.element.classList.remove("touch-controls-pressed")
        // Two fingers can hold the same button
        if (![...this.pressedButtons.values()].some(other => other.key == pressed.key)) {
            this.sendKey(false, pressed.key)
        }
    }

    private onStickDown(event: PointerEvent) {
        if (this.stickPointer != null) {
            return
        }
        event.preventDefault()
        this.stick.setPointerCapture(event.pointerId)
        this.stickPointer = event.pointerId
        this.updateStick(event)
    }
    private onStickMove(event: PointerEvent) {
        if (event.pointerId == this.stickPointer) {
            this.updateStick(event)
        }
    }
    private onStickUp(event: PointerEvent) {
        if (event.pointerId == this.stickPointer) {
            this.releaseStick()
        }
    }

    private updateStick(event: PointerEvent) {
        const rect = this.stick.getBoundingClientRect()
        const radius = rect.width / 2
        const x = event.clientX - (rect.left + radius)
        const y = event.clientY - (rect.top + radius)

        const scale = Math.min(1, radius / Math.max(Math.hypot(x, y), 1))
        this.stickKnob.style.transform = `translate(${x * scale}px, ${y * scale}px)`

        this.setStickKeys(stickKeys(x, y, radius))
    }
    private setStickKeys(keys: Array<number>) {
        for (const key of this.pressedStickKeys) {
            if (keys.indexOf(key) == -1) {
                this.sendKey(false, key)
            }
        }
        for (const key of keys) {
            if (this.pressedStickKeys.indexOf(key) == -1) {
                this.sendKey(true, key)
            }
        }
        this.pressedStickKeys = keys
    }
    private releaseStick() {
        this.stickPointer = null
        this.stickKnob.style.transform = ""
        this.setStickKeys([])
    }

    private releaseAll() {
        this.releaseStick()
        for (const pointerId of [...this.pressedButtons.keys()]) {
            this.releaseButton(pointerId)
        }
    }
}
