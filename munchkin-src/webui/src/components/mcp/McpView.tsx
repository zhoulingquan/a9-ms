import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ExternalLink,
  Loader2,
  Plus,
  PlugZap,
  RefreshCw,
  Trash2,
  Upload,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  fetchMcpPresets,
  runMcpPresetAction,
  saveCustomMcpServer,
  importMcpConfig,
  updateMcpServerTools,
} from "@/lib/api";
import {
  isMcpPresetsPayload,
  MCP_PRESETS_CHANGED_EVENT,
} from "@/lib/mcp-preset-events";
import type { McpPresetField, McpPresetInfo, McpPresetsPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

type TransportType = "stdio" | "sse" | "streamableHttp";

interface McpViewProps {
  onBack: () => void;
  token: string;
}

interface CustomServerForm {
  name: string;
  transport: TransportType;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  tool_timeout: string;
  enabled_tools: string;
}

const EMPTY_FORM: CustomServerForm = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  cwd: "",
  url: "",
  headers: "",
  tool_timeout: "30",
  enabled_tools: "*",
};

type TFunc = (key: string, options?: Record<string, unknown>) => string;

function statusIcon(status: McpPresetInfo["status"]) {
  switch (status) {
    case "configured":
      return <Check className="h-3.5 w-3.5 text-emerald-500" />;
    case "missing_credentials":
    case "missing_dependency":
      return <X className="h-3.5 w-3.5 text-amber-500" />;
    default:
      return <CircleDot className="h-3.5 w-3.5 text-muted-foreground/50" />;
  }
}

export function McpView({ onBack, token }: McpViewProps) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<McpPresetsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CustomServerForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Import modal state
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Active tab: "all" | "connected"
  const [activeTab, setActiveTab] = useState<"all" | "connected">("all");

  // Preset inline form state
  const [expandedPreset, setExpandedPreset] = useState<string | null>(null);
  const [presetFormValues, setPresetFormValues] = useState<
    Record<string, Record<string, string>>
  >({});
  const [enablingPreset, setEnablingPreset] = useState<string | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);

  // Per-server state
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string; toolCount?: number }>
  >({});
  const [showTools, setShowTools] = useState<Record<string, boolean>>({});
  const [enabledToolsCache, setEnabledToolsCache] = useState<
    Record<string, string[]>
  >({});
  const [savingTools, setSavingTools] = useState<Record<string, boolean>>({});

  const loadPresets = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMcpPresets(token);
      setPayload(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPresets();
  }, [token]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (isMcpPresetsPayload(detail)) setPayload(detail);
    };
    window.addEventListener(MCP_PRESETS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(MCP_PRESETS_CHANGED_EVENT, handler);
  }, []);

  const handleRemove = async (name: string) => {
    setActing(name);
    try {
      const updated = await runMcpPresetAction(token, "remove", name, {});
      setPayload(updated);
    } catch {
      // ignore
    } finally {
      setActing(null);
    }
  };

  const handleEnablePreset = async (server: McpPresetInfo) => {
    const fields = server.required_fields ?? [];
    if (fields.length > 0 && expandedPreset !== server.name) {
      setExpandedPreset(server.name);
      setPresetError(null);
      if (!presetFormValues[server.name]) {
        const init: Record<string, string> = {};
        fields.forEach((f) => (init[f.name] = ""));
        setPresetFormValues((prev) => ({ ...prev, [server.name]: init }));
      }
      return;
    }

    const values: Record<string, string> = {};
    if (fields.length > 0) {
      const formVals = presetFormValues[server.name] ?? {};
      const missing = fields.find(
        (f) => f.required && !(formVals[f.name] ?? "").trim(),
      );
      if (missing) {
        setPresetError(t("mcp.presetFields"));
        return;
      }
      fields.forEach((f) => {
        const v = (formVals[f.name] ?? "").trim();
        if (v) values[f.name] = v;
      });
    }

    setEnablingPreset(server.name);
    setPresetError(null);
    try {
      const updated = await runMcpPresetAction(token, "enable", server.name, values);
      setPayload(updated);
      setExpandedPreset(null);
      setPresetFormValues((prev) => {
        const next = { ...prev };
        delete next[server.name];
        return next;
      });
    } catch (e) {
      setPresetError((e as Error).message);
    } finally {
      setEnablingPreset(null);
    }
  };

  const handleSaveCustom = async () => {
    if (!form.name.trim()) {
      setFormError(t("mcp.validation.nameRequired"));
      return;
    }
    if (form.transport === "stdio" && !form.command.trim()) {
      setFormError(t("mcp.validation.commandRequired"));
      return;
    }
    if ((form.transport === "sse" || form.transport === "streamableHttp") && !form.url.trim()) {
      setFormError(t("mcp.validation.urlRequired"));
      return;
    }

    if (form.args.trim()) {
      try {
        JSON.parse(form.args);
      } catch {
        setFormError(t("mcp.validation.invalidJsonArgs"));
        return;
      }
    }
    if (form.env.trim()) {
      try {
        JSON.parse(form.env);
      } catch {
        setFormError(t("mcp.validation.invalidJsonEnv"));
        return;
      }
    }
    if (form.headers.trim()) {
      try {
        JSON.parse(form.headers);
      } catch {
        setFormError(t("mcp.validation.invalidJsonHeaders"));
        return;
      }
    }

    setSaving(true);
    setFormError(null);
    try {
      const values: Record<string, string> = {
        name: form.name.trim(),
        transport: form.transport,
        tool_timeout: form.tool_timeout || "30",
      };
      if (form.transport === "stdio") {
        values.command = form.command.trim();
        if (form.args.trim()) values.args = form.args.trim();
        if (form.env.trim()) values.env = form.env.trim();
        if (form.cwd.trim()) values.cwd = form.cwd.trim();
      } else {
        values.url = form.url.trim();
        if (form.headers.trim()) values.headers = form.headers.trim();
      }
      if (form.enabled_tools.trim()) {
        values.enabled_tools = form.enabled_tools.trim();
      }

      const updated = await saveCustomMcpServer(token, values);
      setPayload(updated);
      setShowForm(false);
      setForm(EMPTY_FORM);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    if (!importText.trim()) {
      setImportError(t("mcp.validation.invalidJsonHeaders"));
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const updated = await importMcpConfig(token, importText);
      setPayload(updated);
      setShowImport(false);
      setImportText("");
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const handleTest = async (name: string) => {
    setTesting((prev) => ({ ...prev, [name]: true }));
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    try {
      const updated = await runMcpPresetAction(token, "test", name, {});
      setPayload(updated);
      const server = updated.presets.find((s) => s.name === name);
      if (server) {
        if (server.status === "configured" && server.tool_count != null) {
          setTestResults((prev) => ({
            ...prev,
            [name]: {
              ok: true,
              message: t("mcp.testSuccess", { count: server.tool_count }),
              toolCount: server.tool_count,
            },
          }));
        } else if (server.status === "configured") {
          setTestResults((prev) => ({
            ...prev,
            [name]: { ok: true, message: t("mcp.testOk") },
          }));
        } else {
          setTestResults((prev) => ({
            ...prev,
            [name]: {
              ok: false,
              message: server.error || t("mcp.testFailed"),
            },
          }));
        }
      }
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [name]: { ok: false, message: (e as Error).message },
      }));
    } finally {
      setTesting((prev) => ({ ...prev, [name]: false }));
    }
  };

  const toggleToolsPanel = (server: McpPresetInfo) => {
    const name = server.name;
    setShowTools((prev) => ({ ...prev, [name]: !prev[name] }));
    if (!enabledToolsCache[name]) {
      const current =
        server.enabled_tools && server.enabled_tools.length > 0
          ? server.enabled_tools.includes("*") && (server.tool_names?.length ?? 0) > 0
            ? [...(server.tool_names ?? [])]
            : [...server.enabled_tools]
          : [];
      setEnabledToolsCache((prev) => ({ ...prev, [name]: current }));
    }
  };

  const handleToggleTool = (name: string, tool: string) => {
    setEnabledToolsCache((prev) => {
      const current = prev[name] ?? [];
      const next = current.includes(tool)
        ? current.filter((item) => item !== tool)
        : [...current, tool];
      return { ...prev, [name]: next };
    });
  };

  const handleSelectAllTools = (name: string, tools: string[]) => {
    setEnabledToolsCache((prev) => ({ ...prev, [name]: [...tools] }));
  };

  const handleClearTools = (name: string) => {
    setEnabledToolsCache((prev) => ({ ...prev, [name]: [] }));
  };

  const handleSaveTools = async (name: string) => {
    const tools = enabledToolsCache[name] ?? [];
    setSavingTools((prev) => ({ ...prev, [name]: true }));
    try {
      const updated = await updateMcpServerTools(token, name, tools);
      setPayload(updated);
      setShowTools((prev) => ({ ...prev, [name]: false }));
    } catch {
      // ignore
    } finally {
      setSavingTools((prev) => ({ ...prev, [name]: false }));
    }
  };

  const allServers = payload?.presets ?? [];
  const connectedServers = allServers.filter(
    (s) => s.installed || s.status === "configured",
  );
  const installed = connectedServers.filter((s) => s.status === "configured");

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
          <ChevronRight className="h-4 w-4 rotate-180" />
        </Button>
        <div className="flex items-center gap-2">
          <PlugZap className="h-4.5 w-4.5 text-foreground/80" />
          <h1 className="text-sm font-semibold">{t("mcp.title")}</h1>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={loadPresets}
            disabled={loading}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading && !payload ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("mcp.loading")}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={loadPresets}>
              {t("mcp.retry")}
            </Button>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            {/* Tab switcher */}
            <div className="mb-3 flex w-fit items-center gap-0.5 rounded-md bg-muted/40 p-0.5">
              <button
                type="button"
                onClick={() => setActiveTab("all")}
                className={cn(
                  "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                  activeTab === "all"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground/70 hover:text-foreground",
                )}
              >
                {t("mcp.allServices")}
                <span className="ml-1 text-[10px] text-muted-foreground/50">
                  ({allServers.length})
                </span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("connected")}
                className={cn(
                  "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                  activeTab === "connected"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground/70 hover:text-foreground",
                )}
              >
                {t("mcp.connected")}
                <span className="ml-1 text-[10px] text-muted-foreground/50">
                  ({connectedServers.length})
                </span>
              </button>
            </div>

            {/* All services tab */}
            {activeTab === "all" && (
              <div className="space-y-2">
                {allServers.length === 0 ? (
                  <p className="py-8 text-center text-[11px] text-muted-foreground/50">
                    {t("mcp.noPresets")}
                  </p>
                ) : (
                  <div className="grid grid-cols-4 gap-1.5">
                    {allServers.map((server) => {
                      const isConnected = server.installed || server.status === "configured";
                      return isConnected ? (
                        <ServerCard
                          key={server.name}
                          server={server}
                          acting={acting}
                          testing={testing[server.name] ?? false}
                          testResult={testResults[server.name]}
                          showTools={showTools[server.name] ?? false}
                          enabledToolsCache={enabledToolsCache[server.name] ?? null}
                          savingTools={savingTools[server.name] ?? false}
                          onRemove={handleRemove}
                          onTest={() => handleTest(server.name)}
                          onToggleTools={() => toggleToolsPanel(server)}
                          onToggleTool={(tool) => handleToggleTool(server.name, tool)}
                          onSelectAll={() =>
                            handleSelectAllTools(
                              server.name,
                              server.tool_names ?? [],
                            )
                          }
                          onClear={() => handleClearTools(server.name)}
                          onSaveTools={() => handleSaveTools(server.name)}
                          t={t as TFunc}
                        />
                      ) : (
                        <PresetCard
                          key={server.name}
                          server={server}
                          expanded={expandedPreset === server.name}
                          formValues={presetFormValues[server.name] ?? {}}
                          enabling={enablingPreset === server.name}
                          error={expandedPreset === server.name ? presetError : null}
                          onEnable={() => handleEnablePreset(server)}
                          onFieldChange={(field, value) =>
                            setPresetFormValues((prev) => ({
                              ...prev,
                              [server.name]: {
                                ...(prev[server.name] ?? {}),
                                [field]: value,
                              },
                            }))
                          }
                          onCancel={() => {
                            setExpandedPreset(null);
                            setPresetError(null);
                            setPresetFormValues((prev) => {
                              const next = { ...prev };
                              delete next[server.name];
                              return next;
                            });
                          }}
                          t={t as TFunc}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Connected services tab */}
            {activeTab === "connected" && (
              <div className="space-y-2">
                {connectedServers.length === 0 ? (
                  <p className="py-8 text-center text-[11px] text-muted-foreground/50">
                    {t("mcp.empty")}
                  </p>
                ) : (
                  <div className="grid grid-cols-4 gap-1.5">
                    {connectedServers.map((server) => (
                      <ServerCard
                        key={server.name}
                        server={server}
                        acting={acting}
                        testing={testing[server.name] ?? false}
                        testResult={testResults[server.name]}
                        showTools={showTools[server.name] ?? false}
                        enabledToolsCache={enabledToolsCache[server.name] ?? null}
                        savingTools={savingTools[server.name] ?? false}
                        onRemove={handleRemove}
                        onTest={() => handleTest(server.name)}
                        onToggleTools={() => toggleToolsPanel(server)}
                        onToggleTool={(tool) => handleToggleTool(server.name, tool)}
                        onSelectAll={() =>
                          handleSelectAllTools(
                            server.name,
                            server.tool_names ?? [],
                          )
                        }
                        onClear={() => handleClearTools(server.name)}
                        onSaveTools={() => handleSaveTools(server.name)}
                        t={t as TFunc}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Add custom server form */}
            {showForm && (
              <section className="mt-3">
                <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {t("mcp.addServer")}
                </h2>
                <div className="space-y-3 rounded-xl border border-border/50 bg-background p-3">
                  <FormField label={t("mcp.form.name")} required>
                    <Input
                      placeholder={t("mcp.form.namePlaceholder")}
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      className="h-8 text-[12.5px]"
                    />
                  </FormField>

                  <FormField label={t("mcp.form.transport")} required>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          className="h-8 w-full justify-between text-[12.5px] font-normal"
                        >
                          {form.transport}
                          <ChevronDown className="h-3.5 w-3.5 opacity-50" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="min-w-[160px]">
                        {(["stdio", "sse", "streamableHttp"] as TransportType[]).map((tp) => (
                          <DropdownMenuItem
                            key={tp}
                            onClick={() => setForm((f) => ({ ...f, transport: tp }))}
                            className="text-[12.5px]"
                          >
                            {tp}
                            {form.transport === tp && <Check className="ml-auto h-3 w-3" />}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </FormField>

                  {form.transport === "stdio" ? (
                    <>
                      <FormField label={t("mcp.form.command")} required>
                        <Input
                          placeholder="npx"
                          value={form.command}
                          onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                          className="h-8 text-[12.5px] font-mono"
                        />
                      </FormField>
                      <FormField label={t("mcp.form.args")}>
                        <Textarea
                          placeholder='["-y", "@playwright/mcp@latest"]'
                          value={form.args}
                          onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                          className="min-h-[56px] text-[12px] font-mono"
                        />
                      </FormField>
                      <FormField label={t("mcp.form.env")}>
                        <Textarea
                          placeholder='{"API_KEY": "sk-..."}'
                          value={form.env}
                          onChange={(e) => setForm((f) => ({ ...f, env: e.target.value }))}
                          className="min-h-[56px] text-[12px] font-mono"
                        />
                      </FormField>
                      <FormField label={t("mcp.form.cwd")}>
                        <Input
                          placeholder="/path/to/working/dir"
                          value={form.cwd}
                          onChange={(e) => setForm((f) => ({ ...f, cwd: e.target.value }))}
                          className="h-8 text-[12.5px] font-mono"
                        />
                      </FormField>
                    </>
                  ) : (
                    <>
                      <FormField label={t("mcp.form.url")} required>
                        <Input
                          placeholder="https://example.com/mcp"
                          value={form.url}
                          onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                          className="h-8 text-[12.5px] font-mono"
                        />
                      </FormField>
                      <FormField label={t("mcp.form.headers")}>
                        <Textarea
                          placeholder='{"Authorization": "Bearer ..."}'
                          value={form.headers}
                          onChange={(e) => setForm((f) => ({ ...f, headers: e.target.value }))}
                          className="min-h-[56px] text-[12px] font-mono"
                        />
                      </FormField>
                    </>
                  )}

                  <FormField label={t("mcp.form.toolTimeout")}>
                    <Input
                      type="number"
                      min={5}
                      max={600}
                      value={form.tool_timeout}
                      onChange={(e) => setForm((f) => ({ ...f, tool_timeout: e.target.value }))}
                      className="h-8 w-24 text-[12.5px]"
                    />
                  </FormField>

                  <FormField label={t("mcp.form.enabledTools")}>
                    <Input
                      placeholder="*"
                      value={form.enabled_tools}
                      onChange={(e) => setForm((f) => ({ ...f, enabled_tools: e.target.value }))}
                      className="h-8 text-[12.5px] font-mono"
                    />
                  </FormField>

                  {formError && (
                    <p className="text-[11px] text-destructive">{formError}</p>
                  )}

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-3 text-[11px]"
                      onClick={() => {
                        setShowForm(false);
                        setForm(EMPTY_FORM);
                        setFormError(null);
                      }}
                    >
                      {t("mcp.form.cancel")}
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 gap-1 px-3 text-[11px]"
                      disabled={saving}
                      onClick={handleSaveCustom}
                    >
                      {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      {t("mcp.form.save")}
                    </Button>
                  </div>
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      <div className="border-t px-4 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground/70">
            {installed.length} {t("mcp.connected").toLowerCase()}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2.5 text-[11px] text-muted-foreground/70 hover:text-foreground"
              onClick={() => {
                setShowImport(true);
                setImportError(null);
                setImportText("");
              }}
            >
              <Upload className="h-3 w-3" />
              {t("mcp.importConfig")}
            </Button>
            <span className="text-muted-foreground/30">·</span>
            <Button
              size="sm"
              className="h-7 gap-1 px-2.5 text-[11px]"
              onClick={() => setShowForm(true)}
            >
              <Plus className="h-3 w-3" />
              {t("mcp.addServer")}
            </Button>
          </div>
        </div>
      </div>

      {/* Import config modal */}
      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border/60 bg-background p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">{t("mcp.importConfig")}</h3>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowImport(false)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Textarea
              placeholder={t("mcp.importPlaceholder")}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              className="min-h-[160px] text-[12px] font-mono"
            />
            {importError && (
              <p className="mt-2 text-[11px] text-destructive">{importError}</p>
            )}
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-3 text-[11px]"
                onClick={() => {
                  setShowImport(false);
                  setImportText("");
                  setImportError(null);
                }}
              >
                {t("mcp.form.cancel")}
              </Button>
              <Button
                size="sm"
                className="h-7 gap-1 px-3 text-[11px]"
                disabled={importing || !importText.trim()}
                onClick={handleImport}
              >
                {importing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                {t("mcp.import")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PresetCard({
  server,
  expanded,
  formValues,
  enabling,
  error,
  onEnable,
  onFieldChange,
  onCancel,
  t,
}: {
  server: McpPresetInfo;
  expanded: boolean;
  formValues: Record<string, string>;
  enabling: boolean;
  error: string | null;
  onEnable: () => void;
  onFieldChange: (field: string, value: string) => void;
  onCancel: () => void;
  t: TFunc;
}) {
  const isConfigured = server.status === "configured";
  const fields = server.required_fields ?? [];
  const needsFields = fields.length > 0;

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border px-2.5 py-2 transition-colors",
        isConfigured
          ? "border-emerald-500/30 bg-emerald-500/[0.04]"
          : "border-border/50 bg-background",
      )}
    >
      <div className="flex items-start gap-2">
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-white"
          style={{ backgroundColor: server.brand_color || "#6b7280" }}
        >
          {server.display_name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-[11.5px] font-medium leading-tight">
              {server.display_name}
            </span>
            {statusIcon(server.status)}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-muted-foreground/70">
            {server.description}
          </p>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-end gap-1.5">
        {isConfigured ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
            <Check className="h-2.5 w-2.5" />
            {t("mcp.enabled")}
          </span>
        ) : (
          <Button
            size="sm"
            className="h-6 gap-1 px-2.5 text-[10.5px]"
            disabled={enabling}
            onClick={onEnable}
          >
            {enabling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            {t("mcp.enable")}
          </Button>
        )}
      </div>

      {expanded && needsFields && (
        <div className="mt-2 space-y-2 rounded-md border border-border/40 bg-muted/20 p-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            {t("mcp.presetFields")}
          </p>
          {fields.map((field: McpPresetField) => (
            <div key={field.name} className="space-y-1">
              <label className="text-[10.5px] font-medium text-muted-foreground/80">
                {field.label}
                {field.required && <span className="ml-0.5 text-destructive">*</span>}
              </label>
              <Input
                type={field.secret ? "password" : "text"}
                placeholder={field.placeholder ?? ""}
                value={formValues[field.name] ?? ""}
                onChange={(e) => onFieldChange(field.name, e.target.value)}
                className="h-6 text-[11.5px]"
              />
            </div>
          ))}
          {server.note && (
            <p className="text-[10px] text-muted-foreground/60">
              <span className="font-medium">{t("mcp.note")}: </span>
              {server.note}
            </p>
          )}
          {error && (
            <p className="text-[10.5px] text-destructive">{error}</p>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2.5 text-[10.5px]"
              onClick={onCancel}
            >
              {t("mcp.form.cancel")}
            </Button>
            <Button
              size="sm"
              className="h-6 gap-1 px-2.5 text-[10.5px]"
              disabled={enabling}
              onClick={onEnable}
            >
              {enabling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              {t("mcp.form.save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ServerCard({
  server,
  acting,
  testing,
  testResult,
  showTools,
  enabledToolsCache,
  savingTools,
  onRemove,
  onTest,
  onToggleTools,
  onToggleTool,
  onSelectAll,
  onClear,
  onSaveTools,
  t,
}: {
  server: McpPresetInfo;
  acting: string | null;
  testing: boolean;
  testResult?: { ok: boolean; message: string; toolCount?: number };
  showTools: boolean;
  enabledToolsCache: string[] | null;
  savingTools: boolean;
  onRemove: (name: string) => void;
  onTest: () => void;
  onToggleTools: () => void;
  onToggleTool: (tool: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onSaveTools: () => void;
  t: TFunc;
}) {
  const isActing = acting === server.name;
  const isConfigured = server.status === "configured";
  const toolNames = server.tool_names ?? [];
  const hasTools = toolNames.length > 0;
  const selected = enabledToolsCache ?? [];

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border px-2.5 py-2 transition-colors",
        isConfigured
          ? "border-emerald-500/20 bg-emerald-500/[0.04]"
          : "border-border/50 bg-background",
      )}
    >
      {/* Header: icon + name + status */}
      <div className="flex items-start gap-2">
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-white"
          style={{ backgroundColor: server.brand_color || "#6b7280" }}
        >
          {server.display_name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-[11.5px] font-semibold leading-tight">
              {server.display_name}
            </span>
            {statusIcon(server.status)}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[9.5px] text-muted-foreground/50">
            <span className="uppercase">{server.transport}</span>
            {server.tool_count != null && server.tool_count > 0 && (
              <>
                <span>·</span>
                <span>{server.tool_count} {t("mcp.tools")}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Body: description */}
      <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-snug text-muted-foreground/70">
        {server.connection_summary || server.description}
      </p>

      {/* Test result */}
      {testResult && (
        <div
          className={cn(
            "mt-1.5 rounded px-1.5 py-1 text-[10.5px]",
            testResult.ok
              ? "bg-emerald-500/10 text-emerald-600"
              : "bg-destructive/10 text-destructive",
          )}
        >
          {testResult.message}
        </div>
      )}

      {/* Tools panel */}
      {showTools && (
        <div className="mt-2 rounded-md border border-border/40 bg-muted/20 p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground/70">
              {t("mcp.toolList")}
            </span>
            {hasTools && (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[9.5px] text-muted-foreground/70"
                  onClick={onSelectAll}
                >
                  {t("mcp.selectAll")}
                </Button>
                <span className="text-muted-foreground/30">·</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[9.5px] text-muted-foreground/70"
                  onClick={onClear}
                >
                  {t("mcp.clearAll")}
                </Button>
              </div>
            )}
          </div>
          {!hasTools ? (
            <p className="py-1.5 text-center text-[10.5px] text-muted-foreground/60">
              {t("mcp.noTools")}
            </p>
          ) : (
            <>
              <div className="max-h-32 space-y-0.5 overflow-y-auto pr-1">
                {toolNames.map((tool) => (
                  <label
                    key={tool}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/30"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(tool)}
                      onChange={() => onToggleTool(tool)}
                      className="h-3 w-3 accent-emerald-500"
                    />
                    <span className="truncate text-[10.5px] font-mono">{tool}</span>
                  </label>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-end border-t border-border/40 pt-1.5">
                <Button
                  size="sm"
                  className="h-6 gap-1 px-2.5 text-[10.5px]"
                  disabled={savingTools}
                  onClick={onSaveTools}
                >
                  {savingTools ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  {t("mcp.saveTools")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Footer: actions */}
      <div className="mt-2 flex items-center justify-between border-t border-border/40 pt-1.5">
        <div className="flex items-center gap-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground/60 hover:text-emerald-600 hover:bg-emerald-500/10"
            disabled={testing}
            onClick={onTest}
            title={t("mcp.test")}
          >
            {testing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Zap className="h-3 w-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground/60 hover:text-sky-600 hover:bg-sky-500/10"
            onClick={onToggleTools}
            title={t("mcp.toolsManage")}
          >
            <Wrench className="h-3 w-3" />
          </Button>
          {server.docs_url && (
            <a
              href={server.docs_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground"
              title="docs"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10"
          disabled={isActing}
          onClick={() => onRemove(server.name)}
          title="delete"
        >
          {isActing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </Button>
      </div>
    </div>
  );
}

function FormField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground/80">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
    </div>
  );
}
