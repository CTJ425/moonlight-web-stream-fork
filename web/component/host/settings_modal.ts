import { StreamPermissions } from "../../api_bindings"
import { getCurrentLanguage, getTranslations } from "../../i18n"
import { FormModal } from "../modal/form"
import { HostSettingKey, HostSettingOverrides, Settings, StreamSettingsComponent } from "../settings_menu"

export class HostSettingsModal extends FormModal<HostSettingOverrides> {

    private modalRoot: HTMLDivElement = document.createElement("div")
    private header: HTMLElement = document.createElement("h2")
    private hint: HTMLParagraphElement = document.createElement("p")

    private settings: StreamSettingsComponent

    constructor(hostName: string, permissions: StreamPermissions, globalSettings: Settings, hostSettings: Settings, overridden: Iterable<HostSettingKey>) {
        super()
        const i = getTranslations(getCurrentLanguage()).host

        this.header.innerText = i.streamSettingsFor(hostName)
        this.modalRoot.appendChild(this.header)

        this.hint.innerText = i.streamSettingsHint
        this.hint.classList.add("host-settings-hint")
        this.modalRoot.appendChild(this.hint)

        this.settings = new StreamSettingsComponent(permissions, hostSettings, { globalSettings, overridden })
        this.settings.mount(this.modalRoot)
    }

    mountForm(form: HTMLFormElement): void {
        form.appendChild(this.modalRoot)
    }

    reset(): void { }
    submit(): HostSettingOverrides | null {
        return this.settings.getHostOverrides()
    }
}
