import { Api, apiGetAdminMonitor, apiPostAdminTerminateAll } from "../../api.js";
import { AdminActiveStream, AdminHostMonitor, AgentGpuStats, GetAdminMonitorResponse } from "../../api_bindings.js";
import { getCurrentLanguage, getTranslations } from "../../i18n.js";
import { Component } from "../index.js";
import { showMessage, showModal } from "../modal/index.js";
import { FormModal } from "../modal/form.js";

const POLL_INTERVAL_MS = 2000

export class MonitorPanel implements Component {

    private api: Api

    private rootDiv = document.createElement("div")

    private actions = document.createElement("div")
    private terminateAllButton = document.createElement("button")
    private agentNote = document.createElement("p")

    private hostGrid = document.createElement("div")

    private streamsTitle = document.createElement("h2")
    private streamsTable = document.createElement("table")

    private pollTimer: number | null = null
    private fetching = false

    constructor(api: Api) {
        this.api = api
        const I = getTranslations(getCurrentLanguage()).admin

        this.rootDiv.classList.add("admin-panel-monitor")

        this.actions.classList.add("monitor-actions")
        this.terminateAllButton.innerText = I.terminateAll
        this.terminateAllButton.classList.add("monitor-terminate-all")
        this.terminateAllButton.addEventListener("click", this.onTerminateAll.bind(this))
        this.actions.appendChild(this.terminateAllButton)
        this.rootDiv.appendChild(this.actions)

        this.agentNote.classList.add("monitor-note")
        this.agentNote.innerText = I.agentDisabled
        this.agentNote.hidden = true
        this.rootDiv.appendChild(this.agentNote)

        this.hostGrid.classList.add("monitor-hosts")
        this.rootDiv.appendChild(this.hostGrid)

        this.streamsTitle.innerText = I.activeStreams
        this.rootDiv.appendChild(this.streamsTitle)

        this.streamsTable.classList.add("monitor-streams")
        this.rootDiv.appendChild(this.streamsTable)
    }

    async forceFetch() {
        if (this.fetching) {
            return
        }
        this.fetching = true

        try {
            const monitor = await apiGetAdminMonitor(this.api)
            this.render(monitor)
        } finally {
            this.fetching = false
        }
    }

    private async onTerminateAll() {
        const I = getTranslations(getCurrentLanguage()).admin

        const confirmed = await showModal(new ConfirmModal(I.terminateAllConfirm))
        if (!confirmed) {
            return
        }

        this.terminateAllButton.disabled = true
        try {
            const result = await apiPostAdminTerminateAll(this.api)

            const hosts = result.hosts
                .map(host => `${host.name}: ${host.success ? "OK" : host.error ?? "failed"}`)
                .join("\n")

            await showMessage(I.terminateAllResult(result.streams_stopped, hosts))
        } finally {
            this.terminateAllButton.disabled = false
            this.forceFetch()
        }
    }

    private render(monitor: GetAdminMonitorResponse) {
        this.agentNote.hidden = monitor.agent_enabled

        this.hostGrid.replaceChildren(...monitor.hosts.map(host => this.renderHost(host)))

        this.renderStreams(monitor.streams)
    }

    private renderHost(host: AdminHostMonitor): HTMLElement {
        const I = getTranslations(getCurrentLanguage()).admin

        const card = document.createElement("div")
        card.classList.add("monitor-host")

        const title = document.createElement("h3")
        title.innerText = host.name
        card.appendChild(title)

        const subtitle = document.createElement("div")
        subtitle.classList.add("monitor-host-address")
        subtitle.innerText = host.paired == "Paired" ? host.address : `${host.address} (${I.notPaired})`
        card.appendChild(subtitle)

        const stats = host.agent
        if (!stats) {
            if (host.agent_error) {
                const error = document.createElement("div")
                error.classList.add("monitor-host-error")
                error.innerText = I.agentUnreachable(host.agent_error)
                card.appendChild(error)
            }
            return card
        }

        card.appendChild(meter(I.cpu, stats.cpu_percent, `${stats.cpu_percent.toFixed(0)}% · ${stats.cpu_cores} cores`))
        card.appendChild(meter(
            I.memory,
            percent(stats.memory_used_bytes, stats.memory_total_bytes),
            `${formatBytes(stats.memory_used_bytes)} / ${formatBytes(stats.memory_total_bytes)}`
        ))

        for (const gpu of stats.gpus) {
            card.appendChild(this.renderGpu(gpu))
        }

        const uptime = document.createElement("div")
        uptime.classList.add("monitor-host-uptime")
        uptime.innerText = `${I.uptime}: ${formatDuration(stats.uptime_secs)}`
        card.appendChild(uptime)

        return card
    }

    private renderGpu(gpu: AgentGpuStats): HTMLElement {
        const I = getTranslations(getCurrentLanguage()).admin

        const container = document.createElement("div")
        container.classList.add("monitor-gpu")

        const name = document.createElement("div")
        name.classList.add("monitor-gpu-name")
        name.innerText = gpu.name
        container.appendChild(name)

        container.appendChild(meter(I.gpu, gpu.utilization_percent, `${gpu.utilization_percent.toFixed(0)}%`))

        // integrated GPUs mostly use shared memory, their dedicated memory is tiny
        const usesShared = gpu.shared_memory_used_bytes > gpu.memory_used_bytes
        if (usesShared) {
            const shared = document.createElement("div")
            shared.classList.add("monitor-gpu-engines")
            shared.innerText = `${I.gpuMemory}: ${formatBytes(gpu.shared_memory_used_bytes)} (shared)`
            container.appendChild(shared)
        } else {
            container.appendChild(meter(
                I.gpuMemory,
                percent(gpu.memory_used_bytes, gpu.memory_total_bytes),
                `${formatBytes(gpu.memory_used_bytes)} / ${formatBytes(gpu.memory_total_bytes)}`
            ))
        }

        const busy: Array<[string, number]> = []
        for (const engine in gpu.engines) {
            const value = gpu.engines[engine]
            if (value != undefined && value >= 1) {
                busy.push([engine, value])
            }
        }
        const busyEngines = busy
            .sort((a, b) => b[1] - a[1])
            .map(([engine, value]) => `${engine} ${value.toFixed(0)}%`)
        if (busyEngines.length > 0) {
            const engines = document.createElement("div")
            engines.classList.add("monitor-gpu-engines")
            engines.innerText = busyEngines.join(" · ")
            container.appendChild(engines)
        }

        return container
    }

    private renderStreams(streams: Array<AdminActiveStream>) {
        const I = getTranslations(getCurrentLanguage()).admin

        if (streams.length == 0) {
            const row = document.createElement("tr")
            const cell = document.createElement("td")
            cell.innerText = I.noActiveStreams
            row.appendChild(cell)
            this.streamsTable.replaceChildren(row)
            return
        }

        const header = document.createElement("tr")
        for (const text of [I.streamUser, I.streamHost, I.streamApp, I.streamStarted]) {
            const cell = document.createElement("th")
            cell.innerText = text
            header.appendChild(cell)
        }

        const rows = streams.map(stream => {
            const row = document.createElement("tr")
            const started = new Date(stream.started_unix_secs * 1000).toLocaleString()
            for (const text of [stream.user_name, stream.host_name, stream.app_name, started]) {
                const cell = document.createElement("td")
                cell.innerText = text
                row.appendChild(cell)
            }
            return row
        })

        this.streamsTable.replaceChildren(header, ...rows)
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.rootDiv)

        if (this.pollTimer == null) {
            this.pollTimer = window.setInterval(() => this.forceFetch(), POLL_INTERVAL_MS)
        }
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.rootDiv)

        if (this.pollTimer != null) {
            window.clearInterval(this.pollTimer)
            this.pollTimer = null
        }
    }
}

class ConfirmModal extends FormModal<boolean> {
    private message = document.createElement("p")

    constructor(message: string) {
        super()
        this.message.innerText = message
    }

    reset(): void { }
    submit(): boolean | null {
        return true
    }
    mountForm(form: HTMLFormElement): void {
        form.appendChild(this.message)
    }
}

function meter(label: string, value: number, text: string): HTMLElement {
    const row = document.createElement("div")
    row.classList.add("monitor-meter")

    const head = document.createElement("div")
    head.classList.add("monitor-meter-head")
    row.appendChild(head)

    const labelElement = document.createElement("span")
    labelElement.innerText = label
    head.appendChild(labelElement)

    const textElement = document.createElement("span")
    textElement.innerText = text
    head.appendChild(textElement)

    const bar = document.createElement("div")
    bar.classList.add("monitor-meter-bar")
    const fill = document.createElement("div")
    fill.classList.add("monitor-meter-fill")
    const clamped = Math.max(0, Math.min(100, value))
    fill.style.width = `${clamped}%`
    if (clamped >= 90) {
        fill.classList.add("monitor-meter-high")
    }
    bar.appendChild(fill)
    row.appendChild(bar)

    return row
}

function percent(used: number, total: number): number {
    return total > 0 ? used / total * 100 : 0
}

function formatBytes(bytes: number): string {
    const gib = bytes / (1024 ** 3)
    if (gib >= 1) {
        return `${gib.toFixed(1)} GB`
    }
    return `${(bytes / (1024 ** 2)).toFixed(0)} MB`
}

function formatDuration(secs: number): string {
    const days = Math.floor(secs / 86400)
    const hours = Math.floor(secs % 86400 / 3600)
    const minutes = Math.floor(secs % 3600 / 60)
    return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`
}
