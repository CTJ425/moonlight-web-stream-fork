import { StreamPermissions } from "../../api_bindings"
import { getCurrentLanguage, getTranslations } from "../../i18n"
import { FormModal } from "../modal/form"
import { Settings, StreamSettingsComponent } from "../settings_menu"

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
