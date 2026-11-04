import { StreamPermissions } from "../../api_bindings.js"
import { getCurrentLanguage, getTranslations } from "../../i18n.js"
import { FormModal } from "../modal/form.js"
import { Settings, StreamSettingsComponent } from "../settings_menu.js"

export class HostSettingsModal extends FormModal<Settings> {

    private modalRoot: HTMLDivElement = document.createElement("div")
    private header: HTMLElement = document.createElement("h2")

    private settings: StreamSettingsComponent

    constructor(hostName: string, permissions: StreamPermissions, settings: Settings) {
        super()
        const i = getTranslations(getCurrentLanguage()).host

        this.header.innerText = i.streamSettingsFor(hostName)
        this.modalRoot.appendChild(this.header)

        this.settings = new StreamSettingsComponent(permissions, settings)
        this.settings.mount(this.modalRoot)
    }

    mountForm(form: HTMLFormElement): void {
        form.appendChild(this.modalRoot)
    }

    reset(): void { }
    submit(): Settings | null {
        return this.settings.getStreamSettings()
    }
}
