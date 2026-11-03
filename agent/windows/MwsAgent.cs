// MwsAgent: tiny Windows service that reports CPU, memory and per-GPU usage as JSON
// for the moonlight-web admin monitor.
//
// GET http://<host>:<port>/stats  with header  Authorization: Bearer <token>
//
// Config: C:\ProgramData\MwsAgent\agent.conf
//   port=47995
//   token=<shared secret, same as host_agent.token in moonlight-web config.json>
//
// Build (no SDK needed, .NET Framework 4.x ships csc):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize /target:exe
//     /out:MwsAgent.exe /r:System.ServiceProcess.dll MwsAgent.cs
// Install:
//   sc.exe create MwsAgent binPath= "C:\ProgramData\MwsAgent\MwsAgent.exe" start= auto
//
// Run interactively for testing: MwsAgent.exe --console

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class Program
{
    static void Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--console")
        {
            var agent = new Agent();
            agent.Start();
            Console.WriteLine("MwsAgent running on port " + agent.Port + ", press Enter to stop");
            Console.ReadLine();
            agent.Stop();
            return;
        }
        ServiceBase.Run(new AgentService());
    }
}

class AgentService : ServiceBase
{
    Agent agent;

    public AgentService()
    {
        ServiceName = "MwsAgent";
        CanStop = true;
    }

    protected override void OnStart(string[] args)
    {
        agent = new Agent();
        agent.Start();
    }

    protected override void OnStop()
    {
        if (agent != null) agent.Stop();
    }
}

class GpuInfo
{
    public string Luid;
    public string Name;
    public ulong DedicatedTotal;
    public ulong DedicatedUsed;
    public ulong SharedUsed;
    public double Util;
    public Dictionary<string, double> Engines = new Dictionary<string, double>();
}

class Snapshot
{
    public double Cpu;
    public int Cores;
    public ulong MemTotal;
    public ulong MemUsed;
    public List<GpuInfo> Gpus = new List<GpuInfo>();
}

class Agent
{
    static readonly string Dir = @"C:\ProgramData\MwsAgent";
    static readonly Regex LuidRe = new Regex(@"luid_0x([0-9A-Fa-f]{8})_0x([0-9A-Fa-f]{8})");
    static readonly Regex EngRe = new Regex(@"_eng_(\d+)_engtype_(.*)$");

    public int Port = 47995;
    string token;
    HttpListener listener;
    Thread sampler;
    volatile bool running;
    volatile Snapshot latest = new Snapshot();

    PerformanceCounter cpuCounter;
    Dictionary<string, CounterSample> lastEngineSamples = new Dictionary<string, CounterSample>();
    Dictionary<string, KeyValuePair<string, ulong>> adapters;
    ulong adaptersTicks;
    bool unknownLuidSeen;

    public void Start()
    {
        LoadConfig();
        running = true;

        sampler = new Thread(SampleLoop) { IsBackground = true };
        sampler.Start();

        listener = new HttpListener();
        listener.Prefixes.Add("http://+:" + Port + "/");
        listener.Start();
        listener.BeginGetContext(OnRequest, null);
        Log("started on port " + Port);
    }

    public void Stop()
    {
        running = false;
        try { listener.Stop(); } catch { }
    }

    void LoadConfig()
    {
        string path = Path.Combine(Dir, "agent.conf");
        foreach (string raw in File.ReadAllLines(path))
        {
            string line = raw.Trim();
            int eq = line.IndexOf('=');
            if (line.StartsWith("#") || eq < 0) continue;
            string key = line.Substring(0, eq).Trim();
            string value = line.Substring(eq + 1).Trim();
            if (key == "port") Port = int.Parse(value, CultureInfo.InvariantCulture);
            else if (key == "token") token = value;
        }
        if (string.IsNullOrEmpty(token)) throw new Exception("token missing in " + path);
    }

    static void Log(string message)
    {
        try
        {
            string path = Path.Combine(Dir, "agent.log");
            var info = new FileInfo(path);
            if (info.Exists && info.Length > 1024 * 1024)
            {
                File.Copy(path, path + ".old", true);
                File.Delete(path);
            }
            File.AppendAllText(path,
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + message + Environment.NewLine);
        }
        catch { }
    }

    // -- Sampling

    void SampleLoop()
    {
        try
        {
            cpuCounter = new PerformanceCounter("Processor", "% Processor Time", "_Total");
            cpuCounter.NextValue();
        }
        catch (Exception e) { Log("cpu counter: " + e.Message); }

        while (running)
        {
            try { latest = Sample(); }
            catch (Exception e) { Log("sample: " + e.Message); }
            Thread.Sleep(1000);
        }
    }

    Snapshot Sample()
    {
        var snap = new Snapshot();
        snap.Cores = Environment.ProcessorCount;
        if (cpuCounter != null) snap.Cpu = Math.Min(100.0, cpuCounter.NextValue());

        var mem = new MEMORYSTATUSEX();
        mem.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
        if (GlobalMemoryStatusEx(ref mem))
        {
            snap.MemTotal = mem.ullTotalPhys;
            snap.MemUsed = mem.ullTotalPhys - mem.ullAvailPhys;
        }

        // LUIDs change when a display driver restarts, and at boot DXGI may not list the GPU yet
        if (adapters == null || ((adapters.Count == 0 || unknownLuidSeen) && GetTickCount64() - adaptersTicks > 10000))
        {
            adapters = Dxgi.Adapters();
            adaptersTicks = GetTickCount64();
        }
        unknownLuidSeen = false;

        var gpus = new Dictionary<string, GpuInfo>();
        foreach (var a in adapters)
        {
            gpus[a.Key] = new GpuInfo { Luid = a.Key, Name = a.Value.Key, DedicatedTotal = a.Value.Value };
        }

        SampleEngines(gpus);
        SampleMemory(gpus);

        // DXGI can list the same GPU a second time (e.g. as the render adapter of an indirect
        // display); that LUID never has counter instances, so drop adapters without any data.
        foreach (GpuInfo gpu in gpus.Values)
        {
            if (gpu.Engines.Count > 0 || gpu.DedicatedUsed > 0 || gpu.SharedUsed > 0) snap.Gpus.Add(gpu);
        }
        return snap;
    }

    // Same method as Task Manager: per engine sum the utilization of all processes,
    // per engine type take the busiest engine, the GPU value is the busiest engine type.
    void SampleEngines(Dictionary<string, GpuInfo> gpus)
    {
        InstanceDataCollectionCollection data;
        try { data = new PerformanceCounterCategory("GPU Engine").ReadCategory(); }
        catch { return; }

        InstanceDataCollection util = data["Utilization Percentage"];
        if (util == null) return;

        var current = new Dictionary<string, CounterSample>();
        // key: luid|engIndex|engType -> summed percent
        var perEngine = new Dictionary<string, double>();

        foreach (InstanceData inst in util.Values)
        {
            string name = inst.InstanceName;
            CounterSample sample = inst.Sample;
            current[name] = sample;

            CounterSample prev;
            if (!lastEngineSamples.TryGetValue(name, out prev)) continue;

            Match l = LuidRe.Match(name);
            Match e = EngRe.Match(name);
            if (!l.Success || !e.Success) continue;

            string luid = LuidKey(l.Groups[1].Value, l.Groups[2].Value);
            string key = luid + "|" + e.Groups[1].Value + "|" + e.Groups[2].Value;
            double value = CounterSample.Calculate(prev, sample);
            // a reused instance name or a counter reset gives a negative or invalid delta
            if (double.IsNaN(value) || double.IsInfinity(value) || value < 0.0) continue;
            double sum;
            perEngine.TryGetValue(key, out sum);
            perEngine[key] = sum + value;
        }
        lastEngineSamples = current;

        foreach (var kv in perEngine)
        {
            string[] parts = kv.Key.Split('|');
            GpuInfo gpu;
            if (!gpus.TryGetValue(parts[0], out gpu))
            {
                unknownLuidSeen = true;
                continue;
            }

            string engType = parts[2];
            if (engType.Length == 0) continue;
            double value = Math.Min(100.0, kv.Value);
            double old;
            if (!gpu.Engines.TryGetValue(engType, out old) || value > old) gpu.Engines[engType] = value;
            if (value > gpu.Util) gpu.Util = value;
        }
    }

    void SampleMemory(Dictionary<string, GpuInfo> gpus)
    {
        InstanceDataCollectionCollection data;
        try { data = new PerformanceCounterCategory("GPU Adapter Memory").ReadCategory(); }
        catch { return; }

        AddMemory(gpus, data["Dedicated Usage"], false);
        AddMemory(gpus, data["Shared Usage"], true);
    }

    static void AddMemory(Dictionary<string, GpuInfo> gpus, InstanceDataCollection counter, bool shared)
    {
        if (counter == null) return;

        foreach (InstanceData inst in counter.Values)
        {
            Match l = LuidRe.Match(inst.InstanceName);
            if (!l.Success) continue;

            GpuInfo gpu;
            if (gpus.TryGetValue(LuidKey(l.Groups[1].Value, l.Groups[2].Value), out gpu))
            {
                if (shared) gpu.SharedUsed += (ulong)inst.RawValue;
                else gpu.DedicatedUsed += (ulong)inst.RawValue;
            }
        }
    }

    static string LuidKey(string high, string low)
    {
        return (high + "_" + low).ToLowerInvariant();
    }

    // -- HTTP

    void OnRequest(IAsyncResult result)
    {
        // Re-arm first: EndGetContext also throws for a single aborted connection
        if (running)
        {
            try { listener.BeginGetContext(OnRequest, null); }
            catch (Exception e) { Log("accept: " + e.Message); }
        }

        HttpListenerContext ctx;
        try { ctx = listener.EndGetContext(result); }
        catch { return; }

        try { Handle(ctx); }
        catch (Exception e) { Log("request: " + e.Message); }
        finally { try { ctx.Response.Close(); } catch { } }
    }

    void Handle(HttpListenerContext ctx)
    {
        string auth = ctx.Request.Headers["Authorization"] ?? "";
        if (!FixedTimeEquals(auth, "Bearer " + token))
        {
            ctx.Response.StatusCode = 401;
            return;
        }
        if (ctx.Request.HttpMethod != "GET" || ctx.Request.Url.AbsolutePath != "/stats")
        {
            ctx.Response.StatusCode = 404;
            return;
        }

        byte[] body = Encoding.UTF8.GetBytes(ToJson(latest));
        ctx.Response.ContentType = "application/json";
        ctx.Response.ContentLength64 = body.Length;
        ctx.Response.OutputStream.Write(body, 0, body.Length);
    }

    static bool FixedTimeEquals(string a, string b)
    {
        if (a.Length != b.Length) return false;
        int diff = 0;
        for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
        return diff == 0;
    }

    static string ToJson(Snapshot s)
    {
        var sb = new StringBuilder();
        sb.Append("{\"hostname\":").Append(Str(Environment.MachineName));
        sb.Append(",\"uptime_secs\":").Append((ulong)(GetTickCount64() / 1000));
        sb.Append(",\"cpu_percent\":").Append(Num(s.Cpu));
        sb.Append(",\"cpu_cores\":").Append(s.Cores);
        sb.Append(",\"memory_total_bytes\":").Append(s.MemTotal);
        sb.Append(",\"memory_used_bytes\":").Append(s.MemUsed);
        sb.Append(",\"gpus\":[");
        for (int i = 0; i < s.Gpus.Count; i++)
        {
            GpuInfo g = s.Gpus[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"name\":").Append(Str(g.Name));
            sb.Append(",\"utilization_percent\":").Append(Num(g.Util));
            sb.Append(",\"memory_total_bytes\":").Append(g.DedicatedTotal);
            sb.Append(",\"memory_used_bytes\":").Append(g.DedicatedUsed);
            sb.Append(",\"shared_memory_used_bytes\":").Append(g.SharedUsed);
            sb.Append(",\"engines\":{");
            bool first = true;
            foreach (var e in g.Engines)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append(Str(e.Key)).Append(':').Append(Num(e.Value));
            }
            sb.Append("}}");
        }
        sb.Append("]}");
        return sb.ToString();
    }

    static string Num(double v)
    {
        if (double.IsNaN(v) || double.IsInfinity(v) || v < 0.0) v = 0.0;
        return Math.Round(v, 1).ToString(CultureInfo.InvariantCulture);
    }

    static string Str(string v)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in v ?? "")
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX buffer);

    [DllImport("kernel32.dll")]
    static extern ulong GetTickCount64();
}

// Hardware GPUs from DXGI: LUID -> (name, dedicated memory). The LUID links them to the
// "GPU Engine" / "GPU Adapter Memory" performance counter instances.
static class Dxgi
{
    public static Dictionary<string, KeyValuePair<string, ulong>> Adapters()
    {
        var result = new Dictionary<string, KeyValuePair<string, ulong>>();
        Guid iid = typeof(IDXGIFactory1).GUID;
        IDXGIFactory1 factory;
        if (CreateDXGIFactory1(ref iid, out factory) != 0) return result;

        for (uint i = 0; ; i++)
        {
            IDXGIAdapter1 adapter;
            if (factory.EnumAdapters1(i, out adapter) != 0) break;

            DXGI_ADAPTER_DESC1 desc;
            adapter.GetDesc1(out desc);
            Marshal.ReleaseComObject(adapter);

            // skip software adapters and Microsoft's basic / remote / indirect adapters
            const uint DXGI_ADAPTER_FLAG_SOFTWARE = 2;
            if ((desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0 || desc.VendorId == 0x1414) continue;

            string luid = ((uint)desc.AdapterLuid.HighPart).ToString("x8") + "_" + desc.AdapterLuid.LowPart.ToString("x8");
            result[luid] = new KeyValuePair<string, ulong>(desc.Description, (ulong)desc.DedicatedVideoMemory);
        }
        Marshal.ReleaseComObject(factory);
        return result;
    }

    [DllImport("dxgi.dll")]
    static extern int CreateDXGIFactory1(ref Guid riid, out IDXGIFactory1 factory);

    [StructLayout(LayoutKind.Sequential)]
    struct LUID
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DXGI_ADAPTER_DESC1
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string Description;
        public uint VendorId;
        public uint DeviceId;
        public uint SubSysId;
        public uint Revision;
        public UIntPtr DedicatedVideoMemory;
        public UIntPtr DedicatedSystemMemory;
        public UIntPtr SharedSystemMemory;
        public LUID AdapterLuid;
        public uint Flags;
    }

    // Only the vtable order matters for the methods that are never called.
    [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIFactory1
    {
        void SetPrivateData();
        void SetPrivateDataInterface();
        void GetPrivateData();
        void GetParent();
        void EnumAdapters();
        void MakeWindowAssociation();
        void GetWindowAssociation();
        void CreateSwapChain();
        void CreateSoftwareAdapter();
        [PreserveSig] int EnumAdapters1(uint index, out IDXGIAdapter1 adapter);
        void IsCurrent();
    }

    [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIAdapter1
    {
        void SetPrivateData();
        void SetPrivateDataInterface();
        void GetPrivateData();
        void GetParent();
        void EnumOutputs();
        void GetDesc();
        void CheckInterfaceSupport();
        [PreserveSig] int GetDesc1(out DXGI_ADAPTER_DESC1 desc);
    }
}
