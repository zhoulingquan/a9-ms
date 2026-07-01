import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  Activity,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Cpu,
  Database,
  Eye,
  EyeOff,
  Gem,
  Globe2,
  Grid3X3,
  HardDrive,
  Hexagon,
  Layers,
  Loader2,
  LogOut,
  Moon,
  Plus,
  Orbit,
  Palette,
  Pencil,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Triangle,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  createModelConfiguration,
  fetchProviderModels,
  fetchSettings,
  loginProviderOAuth,
  logoutProviderOAuth,
  updateModelConfiguration,
  updateNetworkSafetySettings,
  updateProviderSettings,
  updateSettings,
  updateWebSearchSettings,
} from "@/lib/api";
import { getHostApi } from "@/lib/runtime";
import {
  providerBrand,
  providerDisplayLabel,
} from "@/lib/provider-brand";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import type {
  NetworkSafetySettingsUpdate,
  SettingsPayload,
  WebSearchSettingsUpdate,
  WebuiDefaultAccessMode,
} from "@/lib/types";

export type SettingsSectionKey =
  | "overview"
  | "appearance"
  | "models"
  | "browser"
  | "runtime"
  | "advanced";

type LocalDensity = "comfortable" | "compact";
type LocalActivityMode = "auto" | "expanded";
interface LocalPreferences {
  density: LocalDensity;
  activityMode: LocalActivityMode;
  codeWrap: boolean;
  brandLogos: boolean;
}

interface AgentSettingsDraft {
  model: string;
  provider: string;
  modelPreset: string;
  presetLabel: string;
  timezone: string;
  botName: string;
  botIcon: string;
  toolHintMaxLength: number;
}

interface ModelConfigurationDraft {
  label: string;
  provider: string;
  model: string;
}

type PendingRestartSection = "runtime" | "browser";
type PendingRestartSections = Record<PendingRestartSection, boolean>;
type RestartAwarePayload = {
  requires_restart?: boolean;
  surface?: SettingsPayload["surface"];
  runtime_surface?: SettingsPayload["runtime_surface"];
  runtime_capabilities?: SettingsPayload["runtime_capabilities"];
};
type ProviderApiType = "auto" | "chat_completions" | "responses";
type ProviderForm = { apiKey: string; apiBase: string; apiType: ProviderApiType; model: string };

const MUNCHKIN_ICON_SRC = "/brand/munchkin_icon.png";


const FALLBACK_TIMEZONES = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Asia/Taipei",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const LOCAL_PREFS_STORAGE_KEY = "munchkin-webui.settings-preferences";

const DEFAULT_LOCAL_PREFS: LocalPreferences = {
  density: "comfortable",
  activityMode: "auto",
  codeWrap: true,
  brandLogos: true,
};
const OPENAI_API_TYPE_OPTIONS: Array<{ value: ProviderApiType; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "chat_completions", label: "Chat Completions" },
  { value: "responses", label: "Responses" },
];

const LOCAL_UNCONFIGURED_PROVIDER_ORDER = new Map(
  ["vllm", "ollama", "lm_studio", "atomic_chat", "ovms"].map((name, index) => [
    name,
    index,
  ]),
);
const EMPTY_PENDING_RESTART_SECTIONS: PendingRestartSections = {
  runtime: false,
  browser: false,
};

interface SettingsViewProps {
  theme: "light" | "dark" | "system";
  initialSection?: SettingsSectionKey;
  showSidebar?: boolean;
  onThemeChange?: (theme: "light" | "dark" | "system") => void;
  onBackToChat: () => void;
  onModelNameChange: (modelName: string | null) => void;
  onSettingsChange?: (payload: SettingsPayload) => void;
  onWorkspaceSettingsChange?: () => void | Promise<void>;
  onLogout?: () => void;
  onRestart?: () => void;
  isRestarting?: boolean;
  hostChromeInset?: boolean;
}

function readLocalPreferences(): LocalPreferences {
  try {
    const raw = window.localStorage.getItem(LOCAL_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_LOCAL_PREFS;
    const parsed = JSON.parse(raw) as Partial<LocalPreferences>;
    return {
      density: parsed.density === "compact" ? "compact" : "comfortable",
      activityMode: parsed.activityMode === "expanded" ? "expanded" : "auto",
      codeWrap: parsed.codeWrap !== false,
      brandLogos: parsed.brandLogos !== false,
    };
  } catch {
    return DEFAULT_LOCAL_PREFS;
  }
}

function modelPresetValue(payload: SettingsPayload): string {
  return payload.agent.model_preset || "default";
}

function defaultPreset(payload: SettingsPayload): SettingsPayload["model_presets"][number] | null {
  return payload.model_presets.find((preset) => preset.is_default) ?? null;
}

function editableDefaultProvider(payload: SettingsPayload): string {
  const base = defaultPreset(payload);
  return base?.provider ?? payload.agent.provider ?? payload.agent.resolved_provider ?? "";
}

export function SettingsView({
  theme,
  initialSection = "overview",
  showSidebar = true,
  onThemeChange,
  onBackToChat,
  onModelNameChange,
  onSettingsChange,
  onWorkspaceSettingsChange,
  onLogout,
  onRestart,
  isRestarting = false,
  hostChromeInset = false,
}: SettingsViewProps) {
  const { t } = useTranslation();
  const { token } = useClient();
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modelConfigurationOpen, setModelConfigurationOpen] = useState(false);
  const [modelConfigurationSaving, setModelConfigurationSaving] = useState(false);
  const [modelConfigurationForm, setModelConfigurationForm] = useState<ModelConfigurationDraft>({
    label: "",
    provider: "",
    model: "",
  });
  const [providerSaving, setProviderSaving] = useState<string | null>(null);
  const [providerSaved, setProviderSaved] = useState<Record<string, boolean>>({});
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>(() => {
    try {
      const stored = localStorage.getItem("munchkin:providerModels");
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });
  const [providerModelsLoading, setProviderModelsLoading] = useState<string | null>(null);
  const [webSearchSaving, setWebSearchSaving] = useState(false);
  const [networkSafetySaving, setNetworkSafetySaving] = useState(false);
  const [hostEngineApplying, setHostEngineApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionKey>(initialSection);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [providerForms, setProviderForms] = useState<Record<string, ProviderForm>>({});
  const [visibleProviderKeys, setVisibleProviderKeys] = useState<Record<string, boolean>>({});
  const [editingProviderKeys, setEditingProviderKeys] = useState<Record<string, boolean>>({});
  const [pendingRestartSections, setPendingRestartSections] = useState<PendingRestartSections>(
    EMPTY_PENDING_RESTART_SECTIONS,
  );
  const [localPrefs, setLocalPrefs] = useState<LocalPreferences>(() => readLocalPreferences());
  const [webSearchForm, setWebSearchForm] = useState<WebSearchSettingsUpdate>({
    baseUrl: "",
    tavilyApiKey: "",
    maxResults: 8,
    timeout: 30,
    useJinaReader: true,
  });
  const [networkSafetyForm, setNetworkSafetyForm] = useState<NetworkSafetySettingsUpdate>({
    webuiAllowLocalServiceAccess: true,
    webuiDefaultAccessMode: "default",
  });

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);
  const [form, setForm] = useState<AgentSettingsDraft>({
    model: "",
    provider: "",
    modelPreset: "default",
    presetLabel: "Default",
    timezone: "UTC",
    botName: "Munchkin",
    botIcon: "",
    toolHintMaxLength: 40,
  });

  const text = useCallback(
    (key: string, fallback: string, options?: Record<string, unknown>) =>
      t(key, { defaultValue: fallback, ...(options ?? {}) }),
    [t],
  );

  const applyPayload = useCallback((payload: SettingsPayload) => {
    const fallbackDefault = defaultPreset(payload);
    const activePresetName = modelPresetValue(payload);
    const activePreset =
      payload.model_presets.find((preset) => preset.name === activePresetName) ?? fallbackDefault;
    setSettings(payload);
    setForm({
      model: activePreset?.model ?? payload.agent.model,
      provider: activePreset?.is_default
        ? editableDefaultProvider(payload)
        : activePreset?.provider ?? editableDefaultProvider(payload),
      modelPreset: activePresetName,
      presetLabel: activePreset?.label ?? activePresetName,
      timezone: payload.agent.timezone,
      botName: payload.agent.bot_name,
      botIcon: payload.agent.bot_icon,
      toolHintMaxLength: payload.agent.tool_hint_max_length,
    });
    setWebSearchForm((prev) => ({
      baseUrl: payload.web_search.base_url ?? "",
      tavilyApiKey: prev.tavilyApiKey ?? "",
      maxResults: payload.web_search.max_results,
      timeout: payload.web_search.timeout,
      useJinaReader: payload.web.fetch.use_jina_reader,
    }));
    setNetworkSafetyForm({
      webuiAllowLocalServiceAccess: payload.advanced.webui_allow_local_service_access ?? payload.advanced.allow_local_preview_access ?? true,
      webuiDefaultAccessMode: visibleWebuiDefaultAccessMode(payload.advanced.webui_default_access_mode),
    });
    if (payload.restart_required_sections) {
      setPendingRestartSections({
        runtime: payload.restart_required_sections.includes("runtime"),
      browser: payload.restart_required_sections.includes("browser"),
    });
    }
    onSettingsChange?.(payload);
  }, [onSettingsChange]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSettings(token)
      .then((payload) => {
        if (!cancelled) {
          applyPayload(payload);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyPayload, token]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LOCAL_PREFS_STORAGE_KEY, JSON.stringify(localPrefs));
    } catch {
      // Browser-only preferences should never block settings.
    }
  }, [localPrefs]);

  useEffect(() => {
    if (!settings) return;
    setProviderForms((prev) => {
      const next = { ...prev };
      for (const provider of settings.providers) {
        // Find the model associated with this provider: check active preset first,
        // then any preset using this provider, then the agent default model.
        const activePreset = settings.model_presets.find((p) => p.active);
        const matchingPreset =
          activePreset && (activePreset.provider === provider.name || (activePreset.is_default && settings.agent.provider === provider.name))
            ? activePreset
            : settings.model_presets.find((p) => !p.is_default && p.provider === provider.name);
        const inferredModel =
          prev[provider.name]?.model ??
          (matchingPreset ? matchingPreset.model : "") ??
          (settings.agent.provider === provider.name ? settings.agent.model : "") ??
          "";
        next[provider.name] = {
          apiKey: next[provider.name]?.apiKey ?? "",
          apiBase: next[provider.name]?.apiBase ?? provider.api_base ?? provider.default_api_base ?? "",
          apiType: next[provider.name]?.apiType ?? provider.api_type ?? "auto",
          model: inferredModel,
        };
      }
      return next;
    });
    // Mark already-configured providers as saved on initial load / refresh.
    setProviderSaved((prev) => {
      const next = { ...prev };
      for (const provider of settings.providers) {
        if (next[provider.name] === undefined) {
          next[provider.name] = provider.configured;
        }
      }
      return next;
    });
  }, [settings]);

  useEffect(() => {
    try {
      localStorage.setItem("munchkin:providerModels", JSON.stringify(providerModels));
    } catch {
      // ignore quota errors
    }
  }, [providerModels]);

  const modelDirty = useMemo(() => {
    if (!settings) return false;
    const activePresetName = modelPresetValue(settings);
    const selectedPreset = settings.model_presets.find((preset) => preset.name === form.modelPreset);
    if (!selectedPreset) return form.modelPreset !== activePresetName;
    const selectedProvider = selectedPreset.is_default
      ? editableDefaultProvider(settings)
      : selectedPreset.provider;
    return (
      form.modelPreset !== activePresetName ||
      form.model !== selectedPreset.model ||
      form.provider !== selectedProvider ||
      (!selectedPreset.is_default && form.presetLabel.trim() !== selectedPreset.label)
    );
  }, [form, settings]);

  const runtimeDirty = useMemo(() => {
    if (!settings) return false;
    return (
      form.timezone !== settings.agent.timezone ||
      form.botName !== settings.agent.bot_name ||
      form.botIcon !== settings.agent.bot_icon
    );
  }, [form, settings]);

  const networkSafetyDirty = useMemo(() => {
    if (!settings) return false;
    const currentLocalServiceAccess =
      settings.advanced.webui_allow_local_service_access ?? settings.advanced.allow_local_preview_access ?? true;
    const currentDefaultAccess = visibleWebuiDefaultAccessMode(settings.advanced.webui_default_access_mode);
    return (
      networkSafetyForm.webuiAllowLocalServiceAccess !== currentLocalServiceAccess ||
      networkSafetyForm.webuiDefaultAccessMode !== currentDefaultAccess
    );
  }, [networkSafetyForm, settings]);

  const configuredModelProviderOptions = useMemo(
    () =>
      settings?.providers
        .filter((provider) => provider.configured)
        .map((provider) => ({ name: provider.name, label: provider.label })) ?? [],
    [settings],
  );

  const hasPendingRestart = useMemo(
    () =>
      !!settings?.requires_restart ||
      pendingRestartSections.runtime ||
      pendingRestartSections.browser,
    [pendingRestartSections, settings?.requires_restart],
  );

  const restartViaSettingsSurface = useCallback(async () => {
    const isNativeHost = (settings?.surface ?? settings?.runtime_surface) === "native";
    const hostApi = getHostApi();
    if (isNativeHost && settings?.runtime_capabilities?.can_restart_engine && hostApi) {
      setHostEngineApplying(true);
      try {
        await hostApi.restartEngine();
        const payload = await fetchSettings(token);
        applyPayload(payload);
        setPendingRestartSections(EMPTY_PENDING_RESTART_SECTIONS);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setHostEngineApplying(false);
      }
      return;
    }
    onRestart?.();
  }, [applyPayload, onRestart, settings, token]);

  const maybeRestartHostEngine = useCallback(
    async (payload: RestartAwarePayload) => {
      const surface = payload.surface ?? payload.runtime_surface ?? settings?.surface ?? settings?.runtime_surface;
      const capabilities = payload.runtime_capabilities ?? settings?.runtime_capabilities;
      const isNativeHost = surface === "native";
      const hostApi = getHostApi();
      if (!payload.requires_restart || !isNativeHost || !capabilities?.can_restart_engine || !hostApi) {
        return;
      }
      setHostEngineApplying(true);
      try {
        await hostApi.restartEngine();
        const refreshed = await fetchSettings(token);
        applyPayload(refreshed);
        setPendingRestartSections(EMPTY_PENDING_RESTART_SECTIONS);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setHostEngineApplying(false);
      }
    },
    [applyPayload, settings, token],
  );

  const saveModelSettings = async () => {
    if (!settings || !modelDirty || saving) return;
    setSaving(true);
    try {
      const selectedPreset = settings.model_presets.find((preset) => preset.name === form.modelPreset);
      let payload: SettingsPayload;
      if (selectedPreset && !selectedPreset.is_default) {
        payload = await updateModelConfiguration(token, {
          name: selectedPreset.name,
          label: form.presetLabel.trim(),
          model: form.model,
          provider: form.provider,
        });
      } else {
        const defaultModel = defaultPreset(settings)?.model ?? settings.agent.model;
        const defaultProvider = editableDefaultProvider(settings);
        payload = await updateSettings(token, {
          modelPreset: form.modelPreset,
          ...(form.model !== defaultModel ? { model: form.model } : {}),
          ...(form.provider !== defaultProvider ? { provider: form.provider } : {}),
        });
      }
      applyPayload(payload);
      onModelNameChange(payload.agent.model || null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const openModelConfigurationDialog = () => {
    if (!settings) return;
    const currentProvider = settings.agent.provider;
    const provider =
      configuredModelProviderOptions.find((option) => option.name === currentProvider)?.name ??
      configuredModelProviderOptions[0]?.name ??
      "";
    setModelConfigurationForm({
      label: "",
      provider,
      model: "",
    });
    setModelConfigurationOpen(true);
  };

  const handleCreateModelConfiguration = async () => {
    if (modelConfigurationSaving) return;
    const label = modelConfigurationForm.label.trim();
    const provider = modelConfigurationForm.provider.trim();
    const model = modelConfigurationForm.model.trim();
    if (!label || !provider || !model) return;
    setModelConfigurationSaving(true);
    try {
      const payload = await createModelConfiguration(token, {
        label,
        provider,
        model,
      });
      applyPayload(payload);
      onModelNameChange(payload.agent.model || null);
      setModelConfigurationOpen(false);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setModelConfigurationSaving(false);
    }
  };

  const saveRuntimeSettings = async () => {
    if (!settings || !runtimeDirty || saving) return;
    setSaving(true);
    try {
      const payload = await updateSettings(token, {
        timezone: form.timezone,
        botName: form.botName,
        botIcon: form.botIcon,
      });
      applyPayload(payload);
      if (payload.requires_restart) {
        setPendingRestartSections((prev) => ({ ...prev, runtime: true }));
      }
      await onWorkspaceSettingsChange?.();
      await maybeRestartHostEngine(payload);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveNetworkSafetySettings = async () => {
    if (!settings || !networkSafetyDirty || networkSafetySaving) return;
    setNetworkSafetySaving(true);
    try {
      const payload = await updateNetworkSafetySettings(token, networkSafetyForm);
      applyPayload(payload);
      if (payload.requires_restart) {
        setPendingRestartSections((prev) => ({ ...prev, runtime: true }));
      }
      await maybeRestartHostEngine(payload);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setNetworkSafetySaving(false);
    }
  };

  const saveProvider = async (providerName: string) => {
    if (providerSaving) return;
    const provider = settings?.providers.find((item) => item.name === providerName);
    if (!provider) return;
    if (provider.auth_type === "oauth") return;
    const providerForm = providerForms[providerName] ?? { apiKey: "", apiBase: "", apiType: "auto", model: "" };
    const apiKey = providerForm.apiKey.trim();
    const apiKeyRequired = provider.api_key_required ?? true;
    if (!provider.configured && apiKeyRequired && !apiKey) {
      setError(t("settings.byok.apiKeyRequired"));
      return;
    }
    const modelId = providerForm.model.trim();
    setProviderSaving(providerName);
    try {
      let payload = await updateProviderSettings(token, {
        provider: providerName,
        apiKey: apiKey || undefined,
        apiBase: providerForm.apiBase.trim(),
        apiType: providerForm.apiType,
      });
      // If a model ID was entered, also set it as the active model+provider
      // so the user doesn't have to jump to the Models section separately.
      if (modelId) {
        payload = await updateSettings(token, {
          provider: providerName,
          model: modelId,
        });
      }
      applyPayload(payload);
      if (payload.requires_restart) {
        setPendingRestartSections((prev) => ({ ...prev, runtime: true }));
      }
      await maybeRestartHostEngine(payload);
      setProviderForms((prev) => ({
        ...prev,
        [providerName]: {
          apiKey: "",
          apiBase: providerForm.apiBase.trim(),
          apiType: providerForm.apiType,
          model: modelId,
        },
      }));
      setVisibleProviderKeys((prev) => ({ ...prev, [providerName]: false }));
      setEditingProviderKeys((prev) => ({ ...prev, [providerName]: false }));
      setProviderSaved((prev) => ({ ...prev, [providerName]: true }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProviderSaving(null);
    }
  };

  const fetchProviderModelList = async (providerName: string) => {
    if (providerModelsLoading) return;
    const provider = settings?.providers.find((item) => item.name === providerName);
    if (!provider) return;
    const providerForm = providerForms[providerName];
    setProviderModelsLoading(providerName);
    try {
      const models = await fetchProviderModels(token, providerName, {
        apiKey: providerForm?.apiKey.trim() || undefined,
        apiBase: providerForm?.apiBase.trim() || undefined,
      });
      setProviderModels((prev) => ({ ...prev, [providerName]: models }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setProviderModels((prev) => ({ ...prev, [providerName]: [] }));
    } finally {
      setProviderModelsLoading(null);
    }
  };

  const runProviderOAuth = async (providerName: string, action: "login" | "logout") => {
    if (providerSaving) return;
    setProviderSaving(providerName);
    try {
      const payload =
        action === "login"
          ? await loginProviderOAuth(token, providerName)
          : await logoutProviderOAuth(token, providerName);
      applyPayload(payload);
      setExpandedProvider(providerName);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProviderSaving(null);
    }
  };

  const saveWebSearch = async () => {
    if (!settings || webSearchSaving) return;
    setWebSearchSaving(true);
    try {
      const webFetchRestartRequired =
        (webSearchForm.useJinaReader ?? settings.web.fetch.use_jina_reader) !==
        settings.web.fetch.use_jina_reader;
      const update: WebSearchSettingsUpdate = {
        baseUrl: webSearchForm.baseUrl?.trim() ?? "",
        tavilyApiKey: webSearchForm.tavilyApiKey?.trim() || "",
        maxResults: webSearchForm.maxResults,
        timeout: webSearchForm.timeout,
        useJinaReader: webSearchForm.useJinaReader,
      };
      const payload = await updateWebSearchSettings(token, update);
      applyPayload(payload);
      if (payload.requires_restart || webFetchRestartRequired) {
        setPendingRestartSections((prev) => ({ ...prev, browser: true }));
      }
      await maybeRestartHostEngine(payload);
      setWebSearchForm((prev) => ({
        baseUrl: payload.web_search.base_url ?? prev.baseUrl ?? "",
        tavilyApiKey: "",
        maxResults: payload.web_search.max_results,
        timeout: payload.web_search.timeout,
        useJinaReader: payload.web.fetch.use_jina_reader,
      }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWebSearchSaving(false);
    }
  };

  const resetProviderDraft = useCallback((providerName: string) => {
    const provider = settings?.providers.find((item) => item.name === providerName);
    if (!provider) return;
    const activePreset = settings?.model_presets.find((p) => p.active);
    const matchingPreset =
      activePreset && (activePreset.provider === providerName || (activePreset.is_default && settings?.agent.provider === providerName))
        ? activePreset
        : settings?.model_presets.find((p) => !p.is_default && p.provider === providerName);
    setProviderForms((prev) => ({
      ...prev,
      [providerName]: {
        apiKey: "",
        apiBase: provider.api_base ?? provider.default_api_base ?? "",
        apiType: provider.api_type ?? "auto",
        model: matchingPreset?.model ?? (settings?.agent.provider === providerName ? (settings.agent.model || "") : ""),
      },
    }));
    setVisibleProviderKeys((prev) => ({ ...prev, [providerName]: false }));
    setEditingProviderKeys((prev) => ({ ...prev, [providerName]: false }));
  }, [settings]);

  const handleToggleProvider = useCallback((providerName: string) => {
    if (expandedProvider) resetProviderDraft(expandedProvider);
    setExpandedProvider(expandedProvider === providerName ? null : providerName);
  }, [expandedProvider, resetProviderDraft]);

  const resetWebSearchDraft = useCallback(() => {
    if (!settings) return;
    setWebSearchForm({
      baseUrl: settings.web_search.base_url ?? "",
      tavilyApiKey: "",
      maxResults: settings.web_search.max_results,
      timeout: settings.web_search.timeout,
      useJinaReader: settings.web.fetch.use_jina_reader,
    });
  }, [settings]);

  const toggleProviderKeyVisibility = (providerName: string) => {
    const isVisible = visibleProviderKeys[providerName];
    setVisibleProviderKeys((prev) => ({ ...prev, [providerName]: !isVisible }));
  };

  const toggleProviderKeyEditing = (providerName: string) => {
    setEditingProviderKeys((prev) => {
      const nextEditing = !prev[providerName];
      if (!nextEditing) {
        setProviderForms((forms) => ({
          ...forms,
          [providerName]: {
            apiKey: "",
            apiBase: forms[providerName]?.apiBase ?? "",
            apiType: forms[providerName]?.apiType ?? "auto",
            model: forms[providerName]?.model ?? "",
          },
        }));
        setVisibleProviderKeys((visible) => ({ ...visible, [providerName]: false }));
      }
      return { ...prev, [providerName]: nextEditing };
    });
  };

  const renderSection = () => {
    if (!settings) return null;
    switch (activeSection) {
      case "overview":
        return (
          <OverviewSettings
            settings={settings}
            requiresRestart={hasPendingRestart}
            onRestart={restartViaSettingsSurface}
            isRestarting={isRestarting || hostEngineApplying}
            showBrandLogos={localPrefs.brandLogos}
            onSelectSection={setActiveSection}
          />
        );
      case "appearance":
        return (
          <AppearanceSettings
            theme={theme}
            onThemeChange={onThemeChange}
            localPrefs={localPrefs}
            onChangeLocalPrefs={setLocalPrefs}
          />
        );
      case "models":
        return (
          <div className="space-y-8">
            <ModelsSettings
              form={form}
              setForm={setForm}
              settings={settings}
              dirty={modelDirty}
              saving={saving}
              showBrandLogos={localPrefs.brandLogos}
              providerSaving={providerSaving}
              onProviderOAuthLogin={(provider) => runProviderOAuth(provider, "login")}
              onSave={saveModelSettings}
              onCreateConfiguration={openModelConfigurationDialog}
            />
          <ProvidersSettings
              settings={settings}
              expandedProvider={expandedProvider}
              providerForms={providerForms}
              visibleProviderKeys={visibleProviderKeys}
              editingProviderKeys={editingProviderKeys}
              providerSaving={providerSaving}
              providerSaved={providerSaved}
              providerModels={providerModels}
              providerModelsLoading={providerModelsLoading}
              showBrandLogos={localPrefs.brandLogos}
              onToggleProvider={handleToggleProvider}
              onToggleProviderKey={toggleProviderKeyVisibility}
              onToggleProviderKeyEditing={toggleProviderKeyEditing}
              onChangeProviderForm={(provider, value) => {
                setProviderForms((prev) => ({
                  ...prev,
                  [provider]: {
                    apiKey: prev[provider]?.apiKey ?? "",
                    apiBase: prev[provider]?.apiBase ?? "",
                    apiType: prev[provider]?.apiType ?? "auto",
                    model: prev[provider]?.model ?? "",
                    ...value,
                  },
                }));
                setProviderSaved((prev) => ({ ...prev, [provider]: false }));
              }}
              onSaveProvider={saveProvider}
              onFetchProviderModels={fetchProviderModelList}
              onProviderOAuthLogin={(provider) => runProviderOAuth(provider, "login")}
              onProviderOAuthLogout={(provider) => runProviderOAuth(provider, "logout")}
            />
          </div>
        );
      case "browser":
        return (
          <WebSettings
            settings={settings}
            form={webSearchForm}
            saving={webSearchSaving}
            onChangeForm={setWebSearchForm}
            onReset={resetWebSearchDraft}
            onSave={saveWebSearch}
            onRestart={restartViaSettingsSurface}
            isRestarting={isRestarting || hostEngineApplying}
            requiresRestartPending={pendingRestartSections.browser}
          />
        );
      case "runtime":
        return (
          <RuntimeSettings
            form={form}
            setForm={setForm}
            settings={settings}
            dirty={runtimeDirty}
            saving={saving}
            onSave={saveRuntimeSettings}
            onRestart={restartViaSettingsSurface}
            isRestarting={isRestarting || hostEngineApplying}
            requiresRestartPending={pendingRestartSections.runtime}
          />
        );
      case "advanced":
        return (
          <AdvancedSettings
            form={networkSafetyForm}
            dirty={networkSafetyDirty}
            saving={networkSafetySaving}
            isNativeHostSurface={(settings.surface ?? settings.runtime_surface) === "native"}
            onChangeForm={setNetworkSafetyForm}
            onSave={saveNetworkSafetySettings}
            onRestart={restartViaSettingsSurface}
            isRestarting={isRestarting || hostEngineApplying}
            requiresRestartPending={pendingRestartSections.runtime}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(circle_at_50%_0%,hsl(var(--muted))_0%,hsl(var(--background))_42%)] md:flex-row">
      {showSidebar ? (
        <SettingsSidebar
          activeSection={activeSection}
          onSelectSection={setActiveSection}
          onBackToChat={onBackToChat}
          onLogout={onLogout}
          hostChromeInset={hostChromeInset}
        />
      ) : null}

      <NewModelConfigurationDialog
        open={modelConfigurationOpen}
        draft={modelConfigurationForm}
        providers={configuredModelProviderOptions}
        saving={modelConfigurationSaving}
        showProviderLogos={localPrefs.brandLogos}
        onOpenChange={setModelConfigurationOpen}
        onChangeDraft={setModelConfigurationForm}
        onSave={handleCreateModelConfiguration}
      />

      <main className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div
          className={cn(
            "mx-auto w-full max-w-[920px] px-5 py-8 sm:px-8 lg:py-12",
            hostChromeInset && "pt-[4.25rem] sm:pt-[4.25rem] lg:pt-[4.75rem]",
          )}
        >
          <div className="mb-7">
            <p className="mb-2 text-[13px] font-medium text-muted-foreground">
              {t("settings.sidebar.title")}
            </p>
            <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[34px]">
              {text(`settings.nav.${activeSection}`, titleForSection(activeSection))}
            </h1>
          </div>

          {loading ? (
            <div className="flex h-48 items-center justify-center rounded-[24px] border border-border/50 bg-card/75 text-sm text-muted-foreground shadow-[0_20px_70px_rgba(15,23,42,0.07)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.status.loading")}
            </div>
          ) : error && !settings ? (
            <SettingsGroup>
              <SettingsRow title={t("settings.status.loadError")}>
                <span className="max-w-[520px] text-sm text-muted-foreground">{error}</span>
              </SettingsRow>
            </SettingsGroup>
          ) : settings ? (
            <div className="space-y-5">
              {error ? (
                <div className="rounded-[18px] border border-destructive/20 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
                  {error}
                </div>
              ) : null}
              {renderSection()}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

const SETTINGS_NAV_ITEMS: Array<{ key: SettingsSectionKey; icon: LucideIcon; fallback: string }> = [
  { key: "overview", icon: Activity, fallback: "Overview" },
  { key: "appearance", icon: Palette, fallback: "Appearance" },
  { key: "models", icon: SlidersHorizontal, fallback: "Models" },
  { key: "browser", icon: Globe2, fallback: "Web" },
  { key: "runtime", icon: Server, fallback: "System" },
  { key: "advanced", icon: ShieldCheck, fallback: "Security" },
];

function visibleWebuiDefaultAccessMode(mode: string | null | undefined): WebuiDefaultAccessMode {
  return mode === "full" ? "full" : "default";
}

function titleForSection(section: SettingsSectionKey): string {
  return SETTINGS_NAV_ITEMS.find((item) => item.key === section)?.fallback ?? "Settings";
}

function SettingsSidebar({
  activeSection,
  onSelectSection,
  onBackToChat,
  onLogout,
  hostChromeInset,
}: {
  activeSection: SettingsSectionKey;
  onSelectSection: (section: SettingsSectionKey) => void;
  onBackToChat: () => void;
  onLogout?: () => void;
  hostChromeInset?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <aside
      className={cn(
        "flex w-full shrink-0 flex-col border-b border-border/55 bg-card/62 px-4 pb-3 shadow-[inset_0_-1px_0_rgba(255,255,255,0.55)] backdrop-blur-xl dark:bg-card/45 dark:shadow-none md:w-[17rem] md:border-b-0 md:border-r md:px-3 md:pb-4 md:shadow-[inset_-1px_0_0_rgba(255,255,255,0.55)]",
        hostChromeInset ? "pt-[4.25rem] md:pt-[4.25rem]" : "pt-4 md:pt-4",
      )}
    >
      <button
        type="button"
        onClick={onBackToChat}
        className="mb-2 inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground md:mb-3"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        {t("settings.backToChat")}
      </button>
      <div className="mb-3 px-1 md:mb-4 md:px-2">
        <h2 className="text-[21px] font-semibold tracking-[-0.02em] text-foreground">
          {t("settings.sidebar.title")}
        </h2>
      </div>

      <nav
        aria-label={t("settings.sidebar.ariaLabel")}
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:block md:space-y-1 md:overflow-visible md:px-0 md:pb-0"
      >
        {SETTINGS_NAV_ITEMS.map(({ key, icon: Icon, fallback }) => {
          const active = key === activeSection;
          return (
            <button
              key={key}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onSelectSection(key)}
              className={cn(
                "flex h-9 w-auto shrink-0 items-center gap-2 rounded-full px-3 text-left text-[13px] font-medium transition-colors md:w-full md:rounded-[10px] md:px-2.5",
                active
                  ? "bg-muted/90 text-foreground shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)]"
                  : "text-muted-foreground/78 hover:bg-muted/45 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
              <span className="truncate">{t(`settings.nav.${key}`, { defaultValue: fallback })}</span>
            </button>
          );
        })}
      </nav>

      <div className="hidden md:mt-auto md:block md:pt-4">
        {onLogout && !hostChromeInset ? (
          <Button
            type="button"
            variant="ghost"
            onClick={onLogout}
            className="h-9 w-full justify-start gap-2 rounded-[10px] px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-destructive/8 hover:text-destructive"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            {t("app.account.logout")}
          </Button>
        ) : null}
      </div>
    </aside>
  );
}

function OverviewSettings({
  settings,
  requiresRestart,
  onRestart,
  isRestarting,
  onSelectSection,
  showBrandLogos,
}: {
  settings: SettingsPayload;
  requiresRestart: boolean;
  onRestart?: () => void;
  isRestarting?: boolean;
  onSelectSection: (section: SettingsSectionKey) => void;
  showBrandLogos: boolean;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const activePreset = settings.agent.model_preset || "default";
  const activeProvider = settings.agent.resolved_provider ?? settings.agent.provider;
  const webStatus = settings.web.enable
    ? tx("settings.values.enabled", "Enabled")
    : tx("settings.values.disabled", "Disabled");
  return (
    <div className="space-y-7">
      <section>
        <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.075)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.24)]">
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <MunchkinBrandLogo size="lg" testId="overview-munchkin-logo" />
              <div className="min-w-0">
                <div className="text-[12px] font-medium text-muted-foreground">Munchkin</div>
                <div className="mt-0.5 truncate text-[18px] font-semibold leading-6 text-foreground">
                  {settings.agent.model}
                </div>
                <div className="mt-0.5 truncate text-[13px] leading-5 text-muted-foreground">
                  {activeProvider} · {activePreset}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <StatusPill tone={requiresRestart ? "neutral" : "success"}>
                {requiresRestart
                  ? tx("settings.values.restartPending", "Restart pending")
                  : tx("settings.values.ready", "Ready")}
              </StatusPill>
              {requiresRestart && onRestart ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onRestart}
                  disabled={isRestarting}
                  className="rounded-full"
                >
                  {isRestarting ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  )}
                  {isRestarting ? t("app.system.restarting") : t("app.system.restart")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.ai", "AI")}</SettingsSectionTitle>
        <SettingsGroup>
          <OverviewListRow
            icon={Bot}
            valueLogoProvider={activeProvider}
            title={tx("settings.overview.model", "Current model")}
            value={settings.agent.model}
            caption={`${activeProvider} · ${activePreset}`}
            showBrandLogos={showBrandLogos}
            onClick={() => onSelectSection("models")}
          />
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.capabilities", "Capabilities")}</SettingsSectionTitle>
        <SettingsGroup>
          <OverviewListRow
            icon={Globe2}
            title={tx("settings.overview.webSearch", "Web search")}
            value={tx("settings.overview.webSearchAuto", "Auto (Bing → Baidu)")}
            caption={webStatus}
            showBrandLogos={showBrandLogos}
            onClick={() => onSelectSection("browser")}
          />
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.system", "System")}</SettingsSectionTitle>
        <SettingsGroup>
          <OverviewListRow
            icon={Server}
            title={tx("settings.rows.gateway", "Gateway")}
            value={`${settings.runtime.gateway_host}:${settings.runtime.gateway_port}`}
            caption={
              requiresRestart
                ? tx("settings.values.restartPending", "Restart pending")
                : tx("settings.values.ready", "Ready")
            }
            onClick={() => onSelectSection("runtime")}
          />
          <OverviewListRow
            icon={HardDrive}
            title={tx("settings.overview.workspace", "Workspace")}
            value={settings.runtime.workspace_path}
            caption={settings.runtime.config_path}
            onClick={() => onSelectSection("runtime")}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}

function AppearanceSettings({
  theme,
  onThemeChange,
  localPrefs,
  onChangeLocalPrefs,
}: {
  theme: "light" | "dark" | "system";
  onThemeChange?: (theme: "light" | "dark" | "system") => void;
  localPrefs: LocalPreferences;
  onChangeLocalPrefs: Dispatch<SetStateAction<LocalPreferences>>;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>{t("settings.sections.interface")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.rows.theme")}
            description={t("settings.help.theme")}
          >
            <SegmentedControl
              value={theme}
              options={[
                { value: "light", label: t("settings.values.light") },
                { value: "dark", label: t("settings.values.dark") },
                { value: "system", label: t("settings.values.system") },
              ]}
              onChange={(v) => onThemeChange?.(v as "light" | "dark" | "system")}
            />
          </SettingsRow>

          <SettingsRow
            title={t("settings.rows.language")}
            description={t("settings.help.language")}
          >
            <LanguageSwitcher />
          </SettingsRow>
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.localPreferences", "Local preferences")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.density", "Density")}
            description={tx("settings.help.density", "Stored only in this browser.")}
          >
            <SegmentedControl
              value={localPrefs.density}
              options={[
                { value: "comfortable", label: tx("settings.values.comfortable", "Comfortable") },
                { value: "compact", label: tx("settings.values.compact", "Compact") },
              ]}
              onChange={(density) =>
                onChangeLocalPrefs((prev) => ({ ...prev, density: density as LocalDensity }))
              }
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.activityMode", "Activity detail")}
            description={tx("settings.help.activityMode", "Choose how much agent activity chrome to show by default.")}
          >
            <SegmentedControl
              value={localPrefs.activityMode}
              options={[
                { value: "auto", label: tx("settings.values.auto", "Auto") },
                { value: "expanded", label: tx("settings.values.expanded", "Expanded") },
              ]}
              onChange={(activityMode) =>
                onChangeLocalPrefs((prev) => ({ ...prev, activityMode: activityMode as LocalActivityMode }))
              }
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.codeWrap", "Code wrapping")}
            description={tx("settings.help.codeWrap", "Keep long code lines readable on smaller screens.")}
          >
            <ToggleButton
              checked={localPrefs.codeWrap}
              onChange={(codeWrap) => onChangeLocalPrefs((prev) => ({ ...prev, codeWrap }))}
              ariaLabel={tx("settings.rows.codeWrap", "Code wrapping")}
              label={localPrefs.codeWrap ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.brandLogos", "Brand logos")}
            description={tx("settings.help.brandLogos", "Show third-party provider and CLI logos in Settings.")}
          >
            <ToggleButton
              checked={localPrefs.brandLogos}
              onChange={(brandLogos) => onChangeLocalPrefs((prev) => ({ ...prev, brandLogos }))}
              ariaLabel={tx("settings.rows.brandLogos", "Brand logos")}
              label={localPrefs.brandLogos ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>
    </div>
  );
}

function NewModelConfigurationDialog({
  open,
  draft,
  providers,
  saving,
  showProviderLogos,
  onOpenChange,
  onChangeDraft,
  onSave,
}: {
  open: boolean;
  draft: ModelConfigurationDraft;
  providers: Array<{ name: string; label: string }>;
  saving: boolean;
  showProviderLogos: boolean;
  onOpenChange: (open: boolean) => void;
  onChangeDraft: Dispatch<SetStateAction<ModelConfigurationDraft>>;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const canSave = Boolean(draft.label.trim() && draft.provider.trim() && draft.model.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px] rounded-[28px] border-border/55 bg-card/95 p-0 shadow-[0_28px_90px_rgba(15,23,42,0.20)] backdrop-blur-xl dark:border-white/10">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <DialogHeader className="border-b border-border/45 px-5 py-4 text-left">
            <DialogTitle className="text-[18px] font-semibold tracking-[-0.01em]">
              {tx("settings.models.newConfiguration", "New model configuration")}
            </DialogTitle>
            <DialogDescription className="text-[12.5px] leading-5">
              {tx("settings.models.newConfigurationHelp", "Save a provider and model as a one-click option.")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-5 py-5">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
                {tx("settings.models.configurationName", "Name")}
              </span>
              <Input
                autoFocus
                value={draft.label}
                placeholder={tx("settings.models.configurationNamePlaceholder", "Fast writing")}
                onChange={(event) =>
                  onChangeDraft((prev) => ({ ...prev, label: event.target.value }))
                }
                className="h-10 rounded-full px-4 text-[14px]"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
                  {tx("settings.rows.model", "Model")}
                </span>
                <Input
                  value={draft.model}
                  placeholder="openai/gpt-4.1"
                  onChange={(event) =>
                    onChangeDraft((prev) => ({ ...prev, model: event.target.value }))
                  }
                  className="h-10 rounded-full px-4 text-[14px]"
                />
              </label>
              <div className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
                  {tx("settings.rows.provider", "Provider")}
                </span>
                <ProviderPicker
                  providers={providers}
                  value={draft.provider}
                  emptyLabel={tx("settings.byok.noConfiguredProviders", "No configured providers")}
                  showProviderLogos={showProviderLogos}
                  onChange={(provider) =>
                    onChangeDraft((prev) => ({ ...prev, provider }))
                  }
                />
              </div>
            </div>
          </div>

          <DialogFooter className="border-t border-border/45 px-5 py-4 sm:space-x-2">
            <Button
              type="button"
              variant="ghost"
              className="rounded-full"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {tx("settings.actions.cancel", "Cancel")}
            </Button>
            <Button
              type="submit"
              variant="outline"
              className="rounded-full"
              disabled={!canSave || saving || providers.length === 0}
            >
              {saving ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : null}
              {saving ? tx("settings.actions.saving", "Saving...") : tx("settings.actions.save", "Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ModelsSettings({
  form,
  setForm,
  settings,
  dirty,
  saving,
  showBrandLogos,
  providerSaving,
  onProviderOAuthLogin,
  onSave,
  onCreateConfiguration,
}: {
  form: AgentSettingsDraft;
  setForm: Dispatch<SetStateAction<AgentSettingsDraft>>;
  settings: SettingsPayload;
  dirty: boolean;
  saving: boolean;
  showBrandLogos: boolean;
  providerSaving: string | null;
  onProviderOAuthLogin: (provider: string) => void;
  onSave: () => void;
  onCreateConfiguration: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const configuredProviders = settings.providers.filter((provider) => provider.configured);
  const oauthProviders = settings.providers.filter((provider) => provider.auth_type === "oauth");
  const showAutoProvider = defaultPreset(settings)?.provider === "auto" || form.provider === "auto";
  const selectableProviders = uniqueProviders([...configuredProviders, ...oauthProviders]);
  const providerOptions = showAutoProvider
    ? [{ name: "auto", label: tx("settings.values.auto", "Auto") }, ...selectableProviders]
    : selectableProviders;
  const providerValue = providerOptions.some((provider) => provider.name === form.provider)
    ? form.provider
    : "";
  const selectedPreset =
    settings.model_presets.find((preset) => preset.name === form.modelPreset) ?? null;
  const selectedProvider = settings.providers.find((provider) => provider.name === form.provider);
  const selectedProviderNeedsSignIn =
    selectedProvider?.auth_type === "oauth" && !selectedProvider.configured;
  const selectedProviderSigningIn = providerSaving === selectedProvider?.name;
  const modelFieldsMissing =
    !form.model.trim() ||
    !form.provider.trim() ||
    Boolean(selectedPreset && !selectedPreset.is_default && !form.presetLabel.trim());
  return (
    <div className="space-y-7">
      <section>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.currentModel", "Current model")}
            description={tx("settings.help.currentModel", "Choose the model Munchkin uses for new replies.")}
          >
            <ModelPresetPicker
              presets={settings.model_presets}
              value={form.modelPreset}
              settings={settings}
              draftModel={form.model}
              draftProvider={form.provider}
              showProviderLogos={showBrandLogos}
              onChange={(modelPreset) => {
                const nextPreset = settings.model_presets.find((preset) => preset.name === modelPreset);
                setForm((prev) => ({
                  ...prev,
                  modelPreset,
                  model: nextPreset?.model ?? prev.model,
                  provider: nextPreset?.is_default
                    ? editableDefaultProvider(settings)
                    : nextPreset?.provider ?? prev.provider,
                  presetLabel: nextPreset?.label ?? modelPreset,
                }));
              }}
              onCreateConfiguration={onCreateConfiguration}
            />
          </SettingsRow>
          {selectedPreset && !selectedPreset.is_default ? (
            <SettingsRow
              title={tx("settings.models.configurationName", "Name")}
              description={tx("settings.models.configurationNameHelp", "Rename this saved model configuration.")}
            >
              <Input
                value={form.presetLabel}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, presetLabel: event.target.value }))
                }
                className="h-8 w-[min(280px,70vw)] rounded-full text-[13px]"
              />
            </SettingsRow>
          ) : null}
          <SettingsRow
            title={t("settings.rows.provider")}
            description={t("settings.help.provider")}
          >
            <ProviderPicker
              providers={providerOptions}
              value={providerValue}
              emptyLabel={t("settings.byok.noConfiguredProviders")}
              showProviderLogos={showBrandLogos}
              onChange={(provider) => setForm((prev) => ({ ...prev, provider }))}
            />
          </SettingsRow>
          {selectedProviderNeedsSignIn ? (
            <SettingsRow
              title={tx("settings.oauth.signInRequired", "Sign in required")}
              description={tx(
                "settings.oauth.signInBeforeSaving",
                "Sign in before saving this OAuth provider as the active model provider.",
              )}
            >
              <Button
                size="sm"
                variant="outline"
                onClick={() => selectedProvider && onProviderOAuthLogin(selectedProvider.name)}
                disabled={!selectedProvider?.oauth_login_supported || selectedProviderSigningIn}
                className="rounded-full"
              >
                {selectedProviderSigningIn ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : null}
                {selectedProviderSigningIn
                  ? tx("settings.oauth.signingIn", "Signing in...")
                  : tx("settings.oauth.signIn", "Sign in")}
              </Button>
            </SettingsRow>
          ) : null}
          <SettingsFooter
            dirty={dirty}
            saving={saving}
            saved={false}
            disabled={selectedProviderNeedsSignIn || modelFieldsMissing}
            message={
              selectedProviderNeedsSignIn
                ? tx("settings.oauth.signInBeforeSaving", "Sign in before saving this OAuth provider as the active model provider.")
                : undefined
            }
            onSave={onSave}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}

function ProvidersSettings({
  settings,
  expandedProvider,
  providerForms,
  visibleProviderKeys,
  editingProviderKeys,
  providerSaving,
  providerSaved,
  providerModels,
  providerModelsLoading,
  showBrandLogos,
  onToggleProvider,
  onToggleProviderKey,
  onToggleProviderKeyEditing,
  onChangeProviderForm,
  onSaveProvider,
  onFetchProviderModels,
  onProviderOAuthLogin,
  onProviderOAuthLogout,
}: {
  settings: SettingsPayload;
  expandedProvider: string | null;
  providerForms: Record<string, ProviderForm>;
  visibleProviderKeys: Record<string, boolean>;
  editingProviderKeys: Record<string, boolean>;
  providerSaving: string | null;
  providerSaved: Record<string, boolean>;
  providerModels: Record<string, string[]>;
  providerModelsLoading: string | null;
  showBrandLogos: boolean;
  onToggleProvider: (provider: string) => void;
  onToggleProviderKey: (provider: string) => void;
  onToggleProviderKeyEditing: (provider: string) => void;
  onChangeProviderForm: (provider: string, value: Partial<ProviderForm>) => void;
  onSaveProvider: (provider: string) => void;
  onFetchProviderModels: (provider: string) => void;
  onProviderOAuthLogin: (provider: string) => void;
  onProviderOAuthLogout: (provider: string) => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const configuredProviders = settings.providers.filter((provider) => provider.configured);
  const unconfiguredProviders = useMemo(
    () => orderUnconfiguredProviders(settings.providers.filter((provider) => !provider.configured)),
    [settings.providers],
  );
  const renderProviderRow = (provider: SettingsPayload["providers"][number]) => {
    const expanded = expandedProvider === provider.name;
    const form = providerForms[provider.name] ?? {
      apiKey: "",
      apiBase: provider.api_base ?? provider.default_api_base ?? "",
      apiType: provider.api_type ?? "auto",
      model: "",
    };
    const saving = providerSaving === provider.name;
    const saved = !!providerSaved[provider.name];
    const modelsLoading = providerModelsLoading === provider.name;
    const fetchedModels = providerModels[provider.name] ?? [];
    const isOauthProvider = provider.auth_type === "oauth";
    const keyVisible = !!visibleProviderKeys[provider.name];
    const editingKey = !provider.configured || !!editingProviderKeys[provider.name];
    const apiKeyRequired = provider.api_key_required ?? true;
    const apiKey = form.apiKey.trim();
    const apiBase = form.apiBase.trim();
    const missingRequiredApiKey = !isOauthProvider && apiKeyRequired && !provider.configured && !apiKey;
    const missingOptionalCredential =
      !isOauthProvider && !apiKeyRequired && !provider.configured && !apiKey && !apiBase;
    return (
      <div key={provider.name} className="divide-y divide-border/45">
        <button
          type="button"
          onClick={() => onToggleProvider(provider.name)}
          className="flex min-h-[70px] w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/35 sm:px-5"
        >
          <span className="flex min-w-0 items-center gap-3">
            <ProviderIcon
              provider={provider.name}
              showBrandLogos={showBrandLogos}
            />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold leading-5 text-foreground">
                {provider.label}
              </span>
              <span className="block truncate text-[12px] text-muted-foreground">
                {provider.api_base || provider.default_api_base || provider.name}
              </span>
            </span>
          </span>
          <StatusPill tone={provider.configured ? "success" : "neutral"}>
            {isOauthProvider
              ? provider.configured
                ? tx("settings.oauth.signedIn", "Signed in")
                : tx("settings.oauth.notSignedIn", "Not signed in")
              : provider.configured
                ? t("settings.byok.configured")
                : t("settings.byok.notConfigured")}
          </StatusPill>
        </button>

        {expanded ? (
          <div className="space-y-3 bg-muted/18 px-4 py-4 sm:px-5">
            {isOauthProvider ? (
              <div className="flex flex-col gap-3 rounded-[18px] border border-border/45 bg-background/75 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-foreground">
                    {tx("settings.oauth.authentication", "OAuth authentication")}
                  </p>
                  <p className="mt-1 truncate text-[12px] text-muted-foreground">
                    {provider.configured
                      ? t("settings.oauth.signedInAs", {
                          account: provider.oauth_account || provider.label,
                          defaultValue: "Signed in as {{account}}",
                        })
                      : tx("settings.oauth.signInHelp", "Sign in from this device; no API key is stored in config.")}
                  </p>
                </div>
                <div className="flex shrink-0 justify-end gap-2">
                  {provider.configured ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onProviderOAuthLogout(provider.name)}
                      disabled={saving}
                      className="rounded-full"
                    >
                      {tx("settings.oauth.signOut", "Sign out")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onProviderOAuthLogin(provider.name)}
                    disabled={saving || !provider.oauth_login_supported}
                    className="rounded-full"
                  >
                    {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                    {saving
                      ? tx("settings.oauth.signingIn", "Signing in...")
                      : provider.configured
                        ? tx("settings.oauth.signInAgain", "Sign in again")
                        : tx("settings.oauth.signIn", "Sign in")}
                  </Button>
                </div>
              </div>
            ) : (
              <>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
                {t("settings.byok.apiKey")}
              </span>
              <div className="relative">
                {editingKey ? (
                  <>
                    <Input
                      type={keyVisible ? "text" : "password"}
                      value={form.apiKey}
                      onChange={(event) =>
                        onChangeProviderForm(provider.name, { apiKey: event.target.value })
                      }
                      placeholder={
                        provider.configured
                          ? t("settings.byok.apiKeyConfiguredPlaceholder")
                          : t("settings.byok.apiKeyPlaceholder")
                      }
                      className="h-9 rounded-full pr-11 text-[13px]"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => onToggleProviderKey(provider.name)}
                      aria-label={
                        keyVisible
                          ? t("settings.byok.hideApiKey")
                          : t("settings.byok.showApiKey")
                      }
                      className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {keyVisible ? (
                        <EyeOff className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <Eye className="h-3.5 w-3.5" aria-hidden />
                      )}
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="flex h-9 items-center rounded-full border border-input bg-background px-3 pr-11 text-[13px] text-muted-foreground">
                      {provider.api_key_hint ?? t("settings.byok.configuredKeyHint")}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => onToggleProviderKeyEditing(provider.name)}
                      aria-label={t("settings.actions.edit")}
                      className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </>
                )}
              </div>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
                {t("settings.byok.apiBase")}
              </span>
              <Input
                value={form.apiBase}
                onChange={(event) =>
                  onChangeProviderForm(provider.name, { apiBase: event.target.value })
                }
                placeholder={provider.default_api_base ?? t("settings.byok.apiBasePlaceholder")}
                className="h-9 rounded-full text-[13px]"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
                {tx("settings.byok.modelId", "Model ID")}
              </span>
              <div className="flex gap-2">
                <Input
                  value={form.model}
                  onChange={(event) =>
                    onChangeProviderForm(provider.name, { model: event.target.value })
                  }
                  placeholder={tx("settings.byok.modelIdPlaceholder", "e.g. gpt-4o, deepseek-chat")}
                  className="h-9 flex-1 rounded-full text-[13px]"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onFetchProviderModels(provider.name)}
                  disabled={modelsLoading}
                  className="h-9 shrink-0 rounded-full px-3 text-[12px]"
                >
                  {modelsLoading ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />
                  ) : (
                    <Search className="mr-1 h-3 w-3" aria-hidden />
                  )}
                  {modelsLoading
                    ? tx("settings.byok.fetchingModels", "Fetching...")
                    : tx("settings.byok.fetchModels", "Fetch models")}
                </Button>
              </div>
              <span className="block text-[11px] text-muted-foreground/80">
                {tx("settings.byok.modelIdHelp", "Set as active model when saving.")}
              </span>
              {fetchedModels.length > 0 ? (
                <div className="mt-1 max-h-[160px] overflow-y-auto rounded-lg border border-border/45 bg-background/60">
                  {fetchedModels.map((modelId) => (
                    <button
                      key={modelId}
                      type="button"
                      onClick={() => onChangeProviderForm(provider.name, { model: modelId })}
                      className={cn(
                        "block w-full truncate px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-muted/50",
                        form.model === modelId
                          ? "font-semibold text-foreground"
                          : "text-muted-foreground",
                      )}
                      title={modelId}
                    >
                      {modelId}
                    </button>
                  ))}
                </div>
              ) : null}
            </label>
            {provider.name === "openai" ? (
              <label className="block space-y-1.5">
                <span className="text-[12px] font-medium text-muted-foreground">
                  {tx("settings.byok.apiType", "API type")}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 w-full justify-between rounded-full px-3 text-[13px]"
                    >
                      <span>
                        {OPENAI_API_TYPE_OPTIONS.find((option) => option.value === form.apiType)?.label ??
                          form.apiType}
                      </span>
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[220px]">
                    {OPENAI_API_TYPE_OPTIONS.map((option) => (
                      <DropdownMenuItem
                        key={option.value}
                        onSelect={() => onChangeProviderForm(provider.name, { apiType: option.value })}
                      >
                        {option.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </label>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onSaveProvider(provider.name)}
                disabled={saving || saved || missingRequiredApiKey || missingOptionalCredential}
                className={cn(
                  "rounded-full",
                  saved && "opacity-50 cursor-not-allowed",
                )}
              >
                {saving
                  ? t("settings.actions.saving")
                  : saved
                    ? tx("settings.providers.saved", "Saved")
                    : tx("settings.providers.saveProvider", "Save provider")}
              </Button>
            </div>
              </>
            )}
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <div className="space-y-6">
      <p className="max-w-[42rem] text-[13px] leading-6 text-muted-foreground">
        {t("settings.byok.description")}
      </p>
      <ProviderSection
        title={t("settings.byok.configuredSection")}
        count={configuredProviders.length}
        empty={t("settings.byok.noConfiguredProviders")}
      >
        {configuredProviders.map(renderProviderRow)}
      </ProviderSection>
      <ProviderSection
        title={t("settings.byok.notConfiguredSection")}
        count={unconfiguredProviders.length}
        empty={t("settings.byok.noConfiguredProviders")}
      >
        {unconfiguredProviders.map(renderProviderRow)}
      </ProviderSection>
    </div>
  );
}

function WebSettings({
  settings,
  form,
  saving,
  onChangeForm,
  onReset,
  onSave,
  onRestart,
  isRestarting,
  requiresRestartPending,
}: {
  settings: SettingsPayload;
  form: WebSearchSettingsUpdate;
  saving: boolean;
  onChangeForm: Dispatch<SetStateAction<WebSearchSettingsUpdate>>;
  onReset: () => void;
  onSave: () => void;
  onRestart?: () => void;
  isRestarting?: boolean;
  requiresRestartPending: boolean;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const baseUrl = form.baseUrl?.trim() ?? "";
  const tavilyApiKey = form.tavilyApiKey?.trim() ?? "";
  const effectiveJinaReader = form.useJinaReader ?? settings.web.fetch.use_jina_reader;
  const dirty =
    baseUrl !== (settings.web_search.base_url ?? "") ||
    tavilyApiKey.length > 0 ||
    form.maxResults !== settings.web_search.max_results ||
    form.timeout !== settings.web_search.timeout ||
    effectiveJinaReader !== settings.web.fetch.use_jina_reader;
  const jinaReaderDirty = effectiveJinaReader !== settings.web.fetch.use_jina_reader;

  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>{tx("settings.sections.webSearch", "Web search")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.byok.webSearch.baseUrl", "SearXNG instance")}
            description={tx(
              "settings.byok.webSearch.baseUrlHelp",
              "Optional. When set, your self-hosted SearXNG instance is preferred; otherwise Bing → Baidu is used automatically.",
            )}
          >
            <Input
              value={form.baseUrl ?? ""}
              onChange={(event) =>
                onChangeForm((prev) => ({ ...prev, baseUrl: event.target.value }))
              }
              placeholder={t("settings.byok.webSearch.baseUrlPlaceholder")}
              className="h-9 w-[280px] rounded-full text-[13px]"
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.byok.webSearch.tavilyApiKey", "Tavily API Key")}
            description={tx(
              "settings.byok.webSearch.tavilyApiKeyHelp",
              "Optional. When set, Tavily (high quality) is preferred; otherwise Bing → Baidu is used automatically.",
            )}
          >
            <Input
              type="password"
              value={form.tavilyApiKey ?? ""}
              onChange={(event) =>
                onChangeForm((prev) => ({ ...prev, tavilyApiKey: event.target.value }))
              }
              placeholder={tx("settings.byok.webSearch.tavilyApiKeyPlaceholder", "tvly-xxxxxxxx")}
              className="h-9 w-[280px] rounded-full text-[13px]"
            />
          </SettingsRow>
          {settings.web_search.tavily_api_key_hint ? (
            <p className="px-1 text-xs text-muted-foreground">
              {t("settings.byok.configuredKeyHint")}: {settings.web_search.tavily_api_key_hint}
            </p>
          ) : null}
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.webBehavior", "Behavior")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.maxResults", "Max results")}
            description={tx("settings.help.maxResults", "Results returned by each web_search call.")}
          >
            <NumberInput
              value={form.maxResults ?? settings.web_search.max_results}
              min={1}
              max={10}
              onChange={(maxResults) => onChangeForm((prev) => ({ ...prev, maxResults }))}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.timeout", "Timeout")}
            description={tx("settings.help.timeout", "Seconds before a search provider request times out.")}
          >
            <NumberInput
              value={form.timeout ?? settings.web_search.timeout}
              min={1}
              max={120}
              onChange={(timeout) => onChangeForm((prev) => ({ ...prev, timeout }))}
              suffix="s"
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.jinaReader", "Jina reader")}
            description={tx("settings.help.jinaReader", "Use Jina Reader for web_fetch when available.")}
          >
            <ToggleButton
              checked={effectiveJinaReader}
              onChange={(useJinaReader) => onChangeForm((prev) => ({ ...prev, useJinaReader }))}
              ariaLabel={tx("settings.rows.jinaReader", "Jina reader")}
              label={effectiveJinaReader ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
          <RestartSettingsFooter
            dirty={dirty}
            saving={saving}
            pendingRestart={requiresRestartPending}
            message={
              requiresRestartPending && !dirty
                ? tx("settings.status.savedRestartApply", "Saved. Restart when ready.")
                : jinaReaderDirty
                  ? tx("settings.status.restartAfterSaving", "Save changes, then restart when ready.")
                  : dirty
                    ? t("settings.byok.webSearch.saveHint")
                    : undefined
            }
            onSave={onSave}
            onRestart={onRestart}
            onReset={onReset}
            isRestarting={isRestarting}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}
function RuntimeSettings({
  form,
  setForm,
  settings,
  dirty,
  saving,
  onSave,
  onRestart,
  isRestarting,
  requiresRestartPending,
}: {
  form: AgentSettingsDraft;
  setForm: Dispatch<SetStateAction<AgentSettingsDraft>>;
  settings: SettingsPayload;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onRestart?: () => void;
  isRestarting?: boolean;
  requiresRestartPending: boolean;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const isNativeHost = getHostApi() !== null || (settings.surface ?? settings.runtime_surface) === "native";
  const restartActionLabel = isNativeHost
    ? tx("app.system.restartEngine", "Restart engine")
    : t("app.system.restart");
  const restartingActionLabel = isNativeHost
    ? tx("app.system.restartingEngine", "Restarting engine...")
    : t("app.system.restarting");
  const [diagnosticsPath, setDiagnosticsPath] = useState<string | null>(null);
  const [hostActionMessage, setHostActionMessage] = useState<{
    target: "logs" | "diagnostics";
    message: string;
  } | null>(null);
  const [hostActionBusy, setHostActionBusy] =
    useState<"logs" | "diagnostics" | null>(null);
  const hostApi = getHostApi();
  const engineState = isRestarting
    ? tx("settings.values.restartingEngine", "Restarting")
    : settings.apply_state?.status === "pending"
      ? tx("settings.values.pending", "Pending")
      : tx("settings.values.ready", "Ready");
  const runHostAction = async (
    target: "logs" | "diagnostics",
    action: () => Promise<string | void>,
    successMessage: (result: string | void) => string,
    failureMessage: string,
  ) => {
    if (!hostApi) {
      setHostActionMessage({
        target,
        message: tx(
          "settings.status.hostApiUnavailable",
          "Host actions are only available inside the native app.",
        ),
      });
      return;
    }
    setHostActionBusy(target);
    setHostActionMessage(null);
    try {
      const result = await action();
      setHostActionMessage({ target, message: successMessage(result) });
    } catch {
      setHostActionMessage({ target, message: failureMessage });
    } finally {
      setHostActionBusy(null);
    }
  };
  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>{tx("settings.sections.identity", "Identity")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow title={tx("settings.rows.botName", "Bot name")} description={tx("settings.help.botName", "Shown wherever Munchkin uses a display name.")}>
            <Input
              value={form.botName}
              onChange={(event) => setForm((prev) => ({ ...prev, botName: event.target.value }))}
              className="h-8 w-[220px] rounded-full text-[13px]"
            />
          </SettingsRow>
          <SettingsRow title={tx("settings.rows.botIcon", "Bot icon")} description={tx("settings.help.botIcon", "Short emoji or text shown with the bot name.")}>
            <Input
              value={form.botIcon}
              onChange={(event) => setForm((prev) => ({ ...prev, botIcon: event.target.value }))}
              className="h-8 w-[120px] rounded-full text-center text-[13px]"
            />
          </SettingsRow>
          <SettingsRow title={tx("settings.rows.timezone", "Timezone")} description={tx("settings.help.timezone", "Used for schedules and time-aware replies.")}>
            <TimezonePicker
              value={form.timezone}
              onChange={(timezone) => setForm((prev) => ({ ...prev, timezone }))}
            />
          </SettingsRow>
          <RestartSettingsFooter
            dirty={dirty}
            saving={saving}
            pendingRestart={requiresRestartPending}
            dirtyMessage={
              isNativeHost
                ? tx("settings.status.hostRestartAfterSaving", "Save changes and Munchkin will restart its engine.")
                : tx("settings.status.restartAfterSaving", "Save changes, then restart when ready.")
            }
            pendingMessage={
              isNativeHost
                ? tx("settings.status.hostRestartPending", "Saved. Restarting engine when ready.")
                : tx("settings.status.savedRestartApply", "Saved. Restart when ready.")
            }
            onSave={onSave}
            onRestart={onRestart}
            isRestarting={isRestarting}
          />
        </SettingsGroup>
      </section>

      {isNativeHost ? (
        <section>
          <SettingsSectionTitle>{tx("settings.sections.nativeHost", "Native host")}</SettingsSectionTitle>
          <SettingsGroup>
            <ReadOnlyRow title={tx("settings.rows.engine", "Engine")} value={engineState} />
            {settings.runtime_capabilities?.can_open_logs ? (
              <SettingsRow
                title={tx("settings.rows.logs", "Logs")}
                description={
                  hostActionMessage?.target === "logs"
                    ? hostActionMessage.message
                    : tx("settings.help.logs", "Open the native engine log folder.")
                }
              >
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void runHostAction(
                      "logs",
                      () => hostApi!.openLogs(),
                      () => tx("settings.status.logsOpened", "Opened logs folder."),
                      tx("settings.status.logsOpenFailed", "Could not open logs folder."),
                    )
                  }
                  disabled={hostActionBusy !== null}
                  className="rounded-full"
                >
                  {hostActionBusy === "logs"
                    ? tx("settings.actions.opening", "Opening...")
                    : tx("settings.actions.open", "Open")}
                </Button>
              </SettingsRow>
            ) : null}
            {settings.runtime_capabilities?.can_export_diagnostics ? (
              <SettingsRow
                title={tx("settings.rows.diagnostics", "Diagnostics")}
                description={
                  hostActionMessage?.target === "diagnostics"
                    ? hostActionMessage.message
                    : diagnosticsPath
                    ? diagnosticsPath
                    : tx("settings.help.diagnostics", "Export a small runtime report for support.")
                }
              >
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void runHostAction(
                      "diagnostics",
                      async () => {
                        const path = await hostApi!.exportDiagnostics();
                        setDiagnosticsPath(path);
                        return path;
                      },
                      (path) =>
                        t("settings.status.diagnosticsExported", {
                          path: String(path ?? ""),
                          defaultValue: "Diagnostics exported to {{path}}.",
                        }),
                      tx("settings.status.diagnosticsExportFailed", "Could not export diagnostics."),
                    )
                  }
                  disabled={hostActionBusy !== null}
                  className="rounded-full"
                >
                  {hostActionBusy === "diagnostics"
                    ? tx("settings.actions.exporting", "Exporting...")
                    : tx("settings.actions.export", "Export")}
                </Button>
              </SettingsRow>
            ) : null}
          </SettingsGroup>
        </section>
      ) : null}

      <section>
        <SettingsSectionTitle>{t("settings.sections.system")}</SettingsSectionTitle>
        <SettingsGroup>
          <ReadOnlyRow
            title={tx("settings.rows.gateway", "Gateway")}
            value={`${settings.runtime.gateway_host}:${settings.runtime.gateway_port}`}
          />
          <ReadOnlyRow title={t("settings.rows.configPath")} value={settings.runtime.config_path} />
          <ReadOnlyRow title={tx("settings.rows.workspacePath", "Default workspace")} value={settings.runtime.workspace_path} />
          {onRestart && !requiresRestartPending ? (
            <SettingsRow
              title={t("settings.rows.restart")}
              description={t("app.system.restartHint")}
            >
              <Button
                size="sm"
                variant="outline"
                onClick={onRestart}
                disabled={isRestarting}
                className="rounded-full"
              >
                {isRestarting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                )}
                {isRestarting ? restartingActionLabel : restartActionLabel}
              </Button>
            </SettingsRow>
          ) : null}
        </SettingsGroup>
      </section>
    </div>
  );
}

function AdvancedSettings({
  form,
  dirty,
  saving,
  requiresRestartPending,
  isNativeHostSurface,
  onChangeForm,
  onSave,
  onRestart,
  isRestarting,
}: {
  form: NetworkSafetySettingsUpdate;
  dirty: boolean;
  saving: boolean;
  requiresRestartPending: boolean;
  isNativeHostSurface: boolean;
  onChangeForm: Dispatch<SetStateAction<NetworkSafetySettingsUpdate>>;
  onSave: () => void;
  onRestart?: () => void;
  isRestarting?: boolean;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>
          {isNativeHostSurface
            ? tx("settings.sections.hostSafety", "App safety")
            : tx("settings.sections.webuiSafety", "Web safety")}
        </SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.localServiceAccess", "Local Service Access")}
            description={tx(
              isNativeHostSurface ? "settings.help.localServiceAccessNative" : "settings.help.localServiceAccess",
              isNativeHostSurface
                ? "Allow Full Access shell commands to reach services on this Mac."
                : "Allow Full Access shell commands to reach localhost services.",
            )}
          >
            <ToggleButton
              checked={form.webuiAllowLocalServiceAccess}
              onChange={(webuiAllowLocalServiceAccess) =>
                onChangeForm((prev) => ({ ...prev, webuiAllowLocalServiceAccess }))
              }
              ariaLabel={tx("settings.rows.localServiceAccess", "Local Service Access")}
              label={form.webuiAllowLocalServiceAccess ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.webuiDefaultAccess", "Default access")}
            description={tx(
              isNativeHostSurface ? "settings.help.webuiDefaultAccessNative" : "settings.help.webuiDefaultAccess",
              isNativeHostSurface
                ? "Used by native chats without a project-specific permission."
                : "Used by web chats without a project-specific permission.",
            )}
          >
            <SegmentedControl
              value={form.webuiDefaultAccessMode}
              options={[
                { value: "default", label: tx("settings.values.defaultPermission", "Default Permission") },
                { value: "full", label: tx("settings.values.fullAccess", "Full Access") },
              ]}
              onChange={(webuiDefaultAccessMode) =>
                onChangeForm((prev) => ({
                  ...prev,
                  webuiDefaultAccessMode: webuiDefaultAccessMode as WebuiDefaultAccessMode,
                }))
              }
            />
          </SettingsRow>
          <RestartSettingsFooter
            dirty={dirty}
            saving={saving}
            pendingRestart={requiresRestartPending}
            onSave={onSave}
            onRestart={onRestart}
            isRestarting={isRestarting}
          />
        </SettingsGroup>
      </section>

      <p className="max-w-3xl px-1 text-sm leading-6 text-muted-foreground">
        {tx(
          "settings.help.securityManagedControls",
          "Web fetches always protect local, private, and metadata services. Core channel safety stays in config.json.",
        )}
      </p>
    </div>
  );
}

function TimezonePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (timezone: string) => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [query, setQuery] = useState("");
  const options = useMemo(() => timezoneOptions(value), [value]);
  const filteredOptions = useMemo(() => filterTimezoneOptions(options, query), [options, query]);

  return (
    <DropdownMenu onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-8 w-[220px] justify-between rounded-full border-input bg-background px-3 text-[13px] font-normal shadow-none",
            "hover:bg-accent/55 focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <span className="truncate">{value || tx("settings.timezone.select", "Select timezone")}</span>
          <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[340px] max-w-[calc(100vw-2rem)]"
      >
        <div className="sticky top-0 z-10 bg-popover px-1 pb-1">
          <div className="flex h-9 items-center gap-2 rounded-full border border-input bg-background px-3">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
              placeholder={tx("settings.timezone.search", "Search timezone")}
              className="h-7 border-0 bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-0"
            />
          </div>
        </div>
        <div className="mt-1 max-h-[18rem] overflow-y-auto pr-0.5" data-testid="timezone-picker-list">
          {filteredOptions.length ? (
            filteredOptions.map((option) => {
              const selected = option.name === value;
              return (
                <DropdownMenuItem
                  key={option.name}
                  onSelect={() => onChange(option.name)}
                  className={cn(
                    "flex h-9 cursor-default items-center justify-between gap-3 rounded-[12px] px-2.5 text-[13px]",
                    "focus:bg-muted/85 focus:text-foreground",
                    selected && "bg-muted/80 text-foreground focus:bg-muted",
                  )}
                >
                  <span className="min-w-0 truncate font-medium text-foreground">{option.name}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    <span className="text-[11.5px] font-medium text-muted-foreground/80">
                      {option.offset}
                    </span>
                    {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
                  </span>
                </DropdownMenuItem>
              );
            })
          ) : (
            <div className="px-3 py-5 text-center text-[12px] text-muted-foreground">
              {tx("settings.timezone.empty", "No matching timezones.")}
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderPicker({
  providers,
  value,
  emptyLabel,
  showProviderLogos = false,
  onChange,
}: {
  providers: Array<{ name: string; label: string }>;
  value: string;
  emptyLabel: string;
  showProviderLogos?: boolean;
  onChange: (provider: string) => void;
}) {
  const selectedProvider = providers.find((provider) => provider.name === value) ?? null;
  const disabled = providers.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "h-8 w-[210px] justify-between rounded-full border-input bg-background px-3 text-[13px] font-normal shadow-none",
            "hover:bg-accent/55 focus-visible:ring-2 focus-visible:ring-ring",
            disabled && "text-muted-foreground",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selectedProvider && showProviderLogos ? (
              <ProviderPickerIcon
                provider={selectedProvider.name}
                showBrandLogos={showProviderLogos}
              />
            ) : null}
            <span className="truncate">{selectedProvider?.label ?? emptyLabel}</span>
          </span>
          <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[18rem] w-[240px] overflow-y-auto"
      >
        {providers.map((provider) => {
          const selected = provider.name === value;
          return (
            <DropdownMenuItem
              key={provider.name}
              onSelect={() => onChange(provider.name)}
              className={cn(
                "flex cursor-default items-center justify-between gap-2 rounded-[12px] px-2.5 py-2 text-[13px]",
                "focus:bg-muted/85 focus:text-foreground",
                selected && "bg-muted/80 text-foreground focus:bg-muted",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                {showProviderLogos ? (
                  <ProviderPickerIcon
                    provider={provider.name}
                    showBrandLogos={showProviderLogos}
                  />
                ) : null}
                <span className="truncate">{provider.label}</span>
              </span>
              {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderPickerIcon({
  provider,
  showBrandLogos,
}: {
  provider: string;
  showBrandLogos: boolean;
}) {
  const [logoIndex, setLogoIndex] = useState(0);
  const brand = providerBrand(provider);
  const Icon = PROVIDER_ICONS[provider] ?? Sparkles;
  const logoUrl = brand?.logoUrls[logoIndex];

  useEffect(() => setLogoIndex(0), [provider]);

  if (showBrandLogos && logoUrl) {
    return (
      <span
        data-testid={`provider-picker-logo-${provider}`}
        className="grid h-5 w-5 shrink-0 place-items-center overflow-hidden rounded-md border border-border/35 bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.02)]"
        style={{ boxShadow: `inset 0 0 0 1px ${brand.color}22` }}
        aria-hidden
      >
        <img
          src={logoUrl}
          alt=""
          className="h-3.5 w-3.5 object-contain"
          onError={() => setLogoIndex((index) => index + 1)}
        />
      </span>
    );
  }

  if (showBrandLogos && brand) {
    return (
      <span
        data-testid={`provider-picker-logo-fallback-${provider}`}
        className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-[7.5px] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]"
        style={{ backgroundColor: brand.color }}
        aria-hidden
      >
        {brand.initials}
      </span>
    );
  }

  return (
    <span
      className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
      aria-hidden
    >
      <Icon className="h-3 w-3" strokeWidth={2} />
    </span>
  );
}

function ProviderSection({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <ByokSectionHeader title={title} count={count} />
      <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.07)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.22)]">
        {count > 0 ? (
          <div className="divide-y divide-border/45">{children}</div>
        ) : (
          <ByokEmptyState>{empty}</ByokEmptyState>
        )}
      </div>
    </section>
  );
}

function ByokSectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center justify-between px-1">
      <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground/85">
        {title}
      </h2>
      <span className="rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

function ByokEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[18px] border border-dashed border-border/65 bg-card/45 px-4 py-5 text-[13px] text-muted-foreground">
      {children}
    </div>
  );
}

function orderUnconfiguredProviders(
  providers: SettingsPayload["providers"],
): SettingsPayload["providers"] {
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((left, right) => {
      const rank = providerVisibilityRank(left.provider) - providerVisibilityRank(right.provider);
      return rank || left.index - right.index;
    })
    .map(({ provider }) => provider);
}

function uniqueProviders(
  providers: SettingsPayload["providers"],
): SettingsPayload["providers"] {
  const seen = new Set<string>();
  return providers.filter((provider) => {
    if (seen.has(provider.name)) return false;
    seen.add(provider.name);
    return true;
  });
}

function providerVisibilityRank(provider: SettingsPayload["providers"][number]): number {
  const localRank = LOCAL_UNCONFIGURED_PROVIDER_ORDER.get(provider.name);
  if (localRank !== undefined) return localRank;
  if ((provider.api_key_required ?? true) === false) return 100;
  return 200;
}

interface TimezoneOption {
  name: string;
  offset: string;
  searchText: string;
}

function timezoneOptions(current: string): TimezoneOption[] {
  return timezonesWithCurrent(current).map((name) => {
    const offset = timezoneOffset(name);
    return {
      name,
      offset,
      searchText: `${name} ${name.replace(/_/g, " ")} ${offset}`.toLowerCase(),
    };
  });
}

function timezonesWithCurrent(current: string): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  let values: string[] = [];
  try {
    values = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    values = [];
  }
  const deduped = new Set([...FALLBACK_TIMEZONES, ...values, current].filter(Boolean));
  return Array.from(deduped).sort((left, right) => {
    if (left === "UTC") return -1;
    if (right === "UTC") return 1;
    return left.localeCompare(right);
  });
}

function filterTimezoneOptions(options: TimezoneOption[], query: string): TimezoneOption[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return options;
  return options.filter((option) => option.searchText.includes(normalized));
}

function timezoneOffset(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date());
    const value = parts.find((part) => part.type === "timeZoneName")?.value;
    return value ? value.replace(/^GMT$/, "UTC").replace(/^GMT/, "UTC") : "UTC";
  } catch {
    return "Custom timezone";
  }
}

function modelPresetProviderKey(
  preset: SettingsPayload["model_presets"][number],
  settings: SettingsPayload,
  options: { draftProvider?: string } = {},
): string {
  const provider = options.draftProvider ?? preset.provider;
  if (provider === "auto") {
    return settings.agent.resolved_provider || settings.agent.provider || preset.provider;
  }
  return provider;
}

const PROVIDER_ICONS: Record<string, LucideIcon> = {
  custom: Hexagon,
  openrouter: Sparkles,
  skywork: Sparkles,
  aihubmix: Triangle,
  anthropic: Brain,
  openai: Bot,
  deepseek: Waves,
  zhipu: Grid3X3,
  dashscope: Cloud,
  moonshot: Moon,
  minimax: Zap,
  minimax_anthropic: Brain,
  groq: Cpu,
  huggingface: Layers,
  gemini: Gem,
  mistral: Orbit,
  siliconflow: Layers,
  volcengine: Cloud,
  volcengine_coding_plan: Cloud,
  byteplus: Cloud,
  byteplus_coding_plan: Cloud,
  qianfan: Database,
  ant_ling: Sparkles,
  azure_openai: Cloud,
  bedrock: Database,
  exa: Search,
  searxng: Search,
  vllm: Cpu,
  ollama: Cpu,
  lm_studio: Cpu,
  atomic_chat: Cpu,
  ovms: Cpu,
  nvidia: Zap,
};

function ProviderIcon({
  provider,
  showBrandLogos,
}: {
  provider: string;
  showBrandLogos: boolean;
}) {
  const [logoIndex, setLogoIndex] = useState(0);
  const brand = providerBrand(provider);
  const Icon = PROVIDER_ICONS[provider] ?? Hexagon;
  const logoUrl = brand?.logoUrls[logoIndex];

  useEffect(() => setLogoIndex(0), [provider]);

  if (showBrandLogos && logoUrl) {
    return (
      <span
        data-testid={`provider-logo-${provider}`}
        className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-[14px] border border-border/45 bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)]"
        style={{ boxShadow: `inset 0 0 0 1px ${brand.color}22` }}
      >
        <img
          src={logoUrl}
          alt=""
          className="h-6 w-6 object-contain"
          onError={() => setLogoIndex((index) => index + 1)}
        />
      </span>
    );
  }
  if (showBrandLogos && brand) {
    return (
      <span
        data-testid={`provider-logo-fallback-${provider}`}
        className="grid h-10 w-10 shrink-0 place-items-center rounded-[14px] text-[11px] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]"
        style={{ backgroundColor: brand.color }}
        aria-hidden
      >
        {brand.initials}
      </span>
    );
  }
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-muted text-foreground/82 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)] dark:bg-muted/70">
      <Icon className="h-5 w-5" strokeWidth={2} aria-hidden />
    </span>
  );
}

function MunchkinBrandLogo({
  size = "sm",
  testId,
}: {
  size?: "sm" | "lg";
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden border border-border/45 bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)]",
        size === "lg" ? "h-12 w-12 rounded-[16px]" : "h-9 w-9 rounded-[12px]",
      )}
      aria-hidden
    >
      <img
        src={MUNCHKIN_ICON_SRC}
        alt=""
        className={cn("select-none object-contain", size === "lg" ? "h-10 w-10" : "h-7 w-7")}
        draggable={false}
      />
    </span>
  );
}

function OverviewRowIcon({
  icon: Icon,
}: {
  icon: LucideIcon;
}) {
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[12px] bg-muted text-foreground/82 transition-colors group-hover:bg-muted/80 dark:bg-muted/70">
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}

function OverviewValueLogo({
  provider,
  showBrandLogos,
}: {
  provider: string | null | undefined;
  showBrandLogos: boolean;
}) {
  const [logoIndex, setLogoIndex] = useState(0);
  const brand = provider ? providerBrand(provider) : null;
  const logoUrl = brand?.logoUrls[logoIndex];

  useEffect(() => setLogoIndex(0), [provider]);

  if (!provider || !showBrandLogos || !brand) return null;

  if (logoUrl) {
    return (
      <span
        data-testid={`overview-logo-${provider}`}
        className="grid h-5 w-5 shrink-0 place-items-center overflow-hidden rounded-md border border-border/35 bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.02)]"
        style={{ boxShadow: `inset 0 0 0 1px ${brand.color}22` }}
        aria-hidden
      >
        <img
          src={logoUrl}
          alt=""
          className="h-3.5 w-3.5 object-contain"
          onError={() => setLogoIndex((index) => index + 1)}
        />
      </span>
    );
  }

  return (
    <span
      data-testid={`overview-logo-fallback-${provider}`}
      className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-[7.5px] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]"
      style={{ backgroundColor: brand.color }}
      aria-hidden
    >
      {brand.initials}
    </span>
  );
}

function OverviewListRow({
  icon: Icon,
  valueLogoProvider,
  title,
  value,
  caption,
  showBrandLogos = false,
  onClick,
}: {
  icon: LucideIcon;
  valueLogoProvider?: string | null;
  title: string;
  value: string;
  caption: string;
  showBrandLogos?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[68px] w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/30 sm:px-5"
    >
      <OverviewRowIcon icon={Icon} />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium leading-5 text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[12px] leading-5 text-muted-foreground">{caption}</span>
      </span>
      <span className="ml-auto flex min-w-0 max-w-[48%] items-center gap-2">
        <OverviewValueLogo provider={valueLogoProvider} showBrandLogos={showBrandLogos} />
        <span className="truncate text-right text-[13px] leading-5 text-muted-foreground">
          {value}
        </span>
        <ChevronRight
          className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </span>
    </button>
  );
}

function SettingsSectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 px-1 text-[13px] font-semibold tracking-[-0.01em] text-foreground/85">
      {children}
    </h2>
  );
}

function SettingsGroup({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.075)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.24)]">
      <div className="divide-y divide-border/45">{children}</div>
    </div>
  );
}

function SettingsRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[62px] flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0">
        <div className="text-[14px] font-medium leading-5 text-foreground">{title}</div>
        {description ? (
          <div className="mt-0.5 max-w-[28rem] text-[12px] leading-5 text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {children ? <div className="shrink-0 sm:ml-6">{children}</div> : null}
    </div>
  );
}

function ReadOnlyRow({
  title,
  value,
  description,
}: {
  title: string;
  value: string;
  description?: string;
}) {
  return (
    <SettingsRow title={title} description={description}>
      <span className="block max-w-[320px] truncate text-right text-[13px] text-muted-foreground">
        {value}
      </span>
    </SettingsRow>
  );
}

function ModelPresetPicker({
  presets,
  value,
  settings,
  draftModel,
  draftProvider,
  showProviderLogos,
  onChange,
  onCreateConfiguration,
}: {
  presets: SettingsPayload["model_presets"];
  value: string;
  settings: SettingsPayload;
  draftModel: string;
  draftProvider: string;
  showProviderLogos: boolean;
  onChange: (preset: string) => void;
  onCreateConfiguration: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const selectedPreset = presets.find((preset) => preset.name === value) ?? presets[0] ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={!presets.length}>
        <Button
          type="button"
          variant="outline"
          disabled={!presets.length}
          className={cn(
            "h-10 w-[min(340px,72vw)] justify-between rounded-full border-input bg-background px-3 text-[13px] font-normal shadow-none",
            "hover:bg-accent/55 focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {selectedPreset ? (
            <ModelPresetOptionContent
              preset={selectedPreset}
              settings={settings}
              draftModel={draftModel}
              draftProvider={draftProvider}
              showProviderLogos={showProviderLogos}
              compact
            />
          ) : (
            <span className="truncate text-muted-foreground">
              {tx("settings.models.selectModel", "Select model")}
            </span>
          )}
          <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[20rem] w-[340px] max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        {presets.map((preset) => {
          const selected = preset.name === value;
          return (
            <DropdownMenuItem
              key={preset.name}
              onSelect={() => onChange(preset.name)}
              className={cn(
                "flex cursor-default items-center justify-between gap-3 rounded-[12px] px-2.5 py-2 text-[13px]",
                "focus:bg-muted/85 focus:text-foreground",
                selected && "bg-muted/80 text-foreground focus:bg-muted",
              )}
            >
              <ModelPresetOptionContent
                preset={preset}
                settings={settings}
                draftModel={draftModel}
                draftProvider={draftProvider}
                showProviderLogos={showProviderLogos}
              />
              {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
            </DropdownMenuItem>
          );
        })}
        <div className="mt-1 border-t border-border/55 pt-1">
          <DropdownMenuItem
            onSelect={onCreateConfiguration}
            className={cn(
              "flex cursor-default items-center gap-2 rounded-[12px] px-2.5 py-2 text-[13px] font-medium",
              "text-foreground focus:bg-muted/85 focus:text-foreground",
            )}
          >
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </span>
            <span>{tx("settings.models.addConfiguration", "Add configuration")}</span>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelPresetOptionContent({
  preset,
  settings,
  draftModel,
  draftProvider,
  showProviderLogos,
  compact = false,
}: {
  preset: SettingsPayload["model_presets"][number];
  settings: SettingsPayload;
  draftModel: string;
  draftProvider: string;
  showProviderLogos: boolean;
  compact?: boolean;
}) {
  const provider = modelPresetProviderKey(preset, settings, {
    draftProvider: preset.is_default ? draftProvider : undefined,
  });
  const model = preset.is_default ? draftModel : preset.model;
  const providerName = providerDisplayLabel(settings.providers, provider);
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <ProviderPickerIcon provider={provider} showBrandLogos={showProviderLogos} />
      <span className="min-w-0 text-left leading-tight">
        <span className="block truncate font-medium text-foreground">{model || preset.label}</span>
        <span
          className={cn(
            "mt-0.5 block truncate text-muted-foreground",
            compact ? "text-[11.5px]" : "text-[12px]",
          )}
        >
          {providerName}
          {preset.label ? ` · ${preset.label}` : ""}
        </span>
      </span>
    </span>
  );
}

function RestartSettingsFooter({
  dirty,
  saving,
  pendingRestart,
  disabled = false,
  message,
  dirtyMessage,
  pendingMessage,
  onSave,
  onRestart,
  onReset,
  isRestarting,
}: {
  dirty: boolean;
  saving: boolean;
  pendingRestart: boolean;
  disabled?: boolean;
  message?: string;
  dirtyMessage?: string;
  pendingMessage?: string;
  onSave: () => void;
  onRestart?: () => void;
  onReset?: () => void;
  isRestarting?: boolean;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const isNativeHost = getHostApi() !== null;
  const restartLabel = isNativeHost
    ? tx("app.system.restartEngine", "Restart engine")
    : t("app.system.restart");
  const restartingLabel = isNativeHost
    ? tx("app.system.restartingEngine", "Restarting engine...")
    : t("app.system.restarting");
  const statusMessage =
    message ??
    (pendingRestart && !dirty
      ? pendingMessage ?? tx("settings.status.savedRestartApply", "Saved. Restart when ready.")
      : dirty
        ? dirtyMessage ?? t("settings.status.unsaved")
        : undefined);
  const statusTone = disabled ? "danger" : dirty || pendingRestart ? "accent" : undefined;

  return (
    <div className="flex min-h-[58px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0 text-[13px] leading-5 text-muted-foreground">
        <SettingsStatusMessage tone={statusTone}>{statusMessage}</SettingsStatusMessage>
      </div>
      <div className="flex w-full shrink-0 flex-wrap justify-end gap-2 sm:w-auto">
        {pendingRestart && !dirty && onRestart ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onRestart}
            disabled={isRestarting}
            className="rounded-full"
          >
            {isRestarting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            )}
            {isRestarting ? restartingLabel : restartLabel}
          </Button>
        ) : null}
        {onReset ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onReset}
            disabled={!dirty || saving}
            className="rounded-full"
          >
            {t("settings.actions.cancel")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={onSave}
          disabled={!dirty || disabled || saving}
          className="rounded-full"
        >
          {saving ? t("settings.actions.saving") : t("settings.actions.save")}
        </Button>
      </div>
    </div>
  );
}

function SettingsFooter({
  dirty,
  saving,
  saved,
  disabled = false,
  message,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  disabled?: boolean;
  message?: string;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const statusMessage = message ?? (dirty
    ? t("settings.status.unsaved")
    : saved
      ? t("settings.status.savedRestart")
      : tx("settings.status.upToDate", "Up to date."));
  return (
    <div className="flex min-h-[58px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="text-[13px] text-muted-foreground">
        <SettingsStatusMessage tone={disabled ? "danger" : dirty || saved ? "accent" : undefined}>
          {statusMessage}
        </SettingsStatusMessage>
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={onSave} disabled={!dirty || disabled || saving} className="rounded-full">
          {saving ? t("settings.actions.saving") : t("settings.actions.save")}
        </Button>
      </div>
    </div>
  );
}

function SettingsStatusMessage({
  children,
  tone,
}: {
  children?: ReactNode;
  tone?: "accent" | "danger";
}) {
  if (!children) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2",
        tone === "accent" && "font-medium text-blue-600 dark:text-blue-300",
        tone === "danger" && "font-medium text-destructive",
      )}
    >
      {tone ? (
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            tone === "accent" &&
              "bg-blue-500 shadow-[0_0_0_3px_rgba(59,130,246,0.14)] dark:bg-blue-400 dark:shadow-[0_0_0_3px_rgba(96,165,250,0.18)]",
            tone === "danger" && "bg-destructive/70",
          )}
          aria-hidden
        />
      ) : null}
      <span>{children}</span>
    </span>
  );
}

function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-[260px] items-center rounded-full px-2.5 py-1 text-[12px] font-medium",
        tone === "success" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warning" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex h-8 items-center rounded-full bg-muted p-0.5 text-[12px] font-medium text-muted-foreground">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-full px-3 py-1 transition-colors",
            value === option.value && "bg-background text-foreground shadow-sm",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ToggleButton({
  checked,
  onChange,
  ariaLabel,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-[2px]",
        "transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        checked
          ? "bg-[#2997FF] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.035)]"
          : "bg-muted shadow-[inset_0_0_0_1px_rgba(0,0,0,0.035)] hover:bg-muted/80",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-[18px] w-[18px] rounded-full bg-background shadow-[0_1px_2px_rgba(0,0,0,0.18),0_2px_7px_rgba(0,0,0,0.11)]",
          "transition-transform duration-200 ease-out",
          checked ? "translate-x-[16px]" : "translate-x-0",
        )}
      />
      <span className="sr-only">{label}</span>
    </button>
  );
}

function NumberInput({
  value,
  min,
  max,
  onChange,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        className="h-8 w-24 rounded-full text-[13px]"
      />
      {suffix ? <span className="text-[12px] text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}
