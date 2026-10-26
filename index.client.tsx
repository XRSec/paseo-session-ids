import { useState, useEffect, useMemo, useCallback } from "react";
import { View, Text, Pressable } from "react-native";
import type {
  PluginClientContext,
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginAgentCommandContext,
} from "@getpaseo/plugin/client";
import { usePaseo, defineTranslations, useTranslation } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/ui";

export const messages = defineTranslations({
  resources: {
    en: {
      buttonTitle: "Session IDs",
      buttonLabel: "IDs",
      commandTitle: "Copy current session IDs (Paseo & CLI)",
      slashDescription: "Quickly view and copy current session Paseo ID and CLI ID",
      copiedPaseo: "Copied Paseo session ID",
      copiedCli: "Copied CLI ID ({{provider}})",
      copiedResume: "Copied resume command",
      cliPending: "CLI session ID not ready yet, please refresh later",
      copyFailed: "Failed to copy",
      copyBtn: "Copy",
      generating: "Generating...",
    },
    "zh-CN": {
      buttonTitle: "会话 ID",
      buttonLabel: "IDs",
      commandTitle: "复制当前会话 ID (Paseo ID & CLI ID)",
      slashDescription: "快速获取并复制当前会话的 Paseo ID 与 CLI ID",
      copiedPaseo: "已复制 Paseo 会话 ID",
      copiedCli: "已复制 CLI ID ({{provider}})",
      copiedResume: "已复制恢复命令",
      cliPending: "CLI 会话 ID 尚未生成，请稍后刷新重试",
      copyFailed: "复制失败",
      copyBtn: "复制",
      generating: "生成中...",
    },
  },
});

export interface ParsedSessionInfo {
  paseoId: string;
  provider: string;
  cliId: string | null;
  rawSessionId: string | null;
  nativeHandle: string | null;
  resumeCommand: string | null;
  providerNote: string;
}

/**
 * 解析 Agent 的 Paseo ID 与底层 CLI 会话 ID。
 * 特别适配：
 * 1. Antigravity (agy): 解析 plugin:{"version":1,"data":{"conversationId":"..."}} 提取纯净 conversationId
 * 2. Claude: 原生 session UUID
 * 3. Pi: 原生 session ID 与 jsonl 路径
 * 4. Codex: 原生 threadId
 * 5. Hermes / OMP / OpenCode 等通用 CLI 驱动
 */
export function parseAgentSession(agent: {
  id: string;
  provider: string;
  persistence?: {
    sessionId?: string | null;
    nativeHandle?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  runtimeInfo?: {
    sessionId?: string | null;
  } | null;
}): ParsedSessionInfo {
  const paseoId = agent.id;
  const provider = agent.provider ?? "unknown";
  const rawSessionId =
    agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId ?? null;
  const nativeHandle = agent.persistence?.nativeHandle ?? null;

  let cliId: string | null = null;
  let providerNote = "CLI 原生会话 ID";

  const p = provider.toLowerCase();
  if (p.includes("antigravity") || p === "agy") {
    providerNote = "Antigravity conversationId";
  } else if (p.includes("claude")) {
    providerNote = "Claude Session UUID";
  } else if (p.includes("pi")) {
    providerNote = "Pi Session ID";
  } else if (p.includes("codex")) {
    providerNote = "Codex Thread ID";
  }

  // 1. 尝试从 plugin: 前缀的 JSON 数据提取 (如 Antigravity 插件)
  if (rawSessionId && rawSessionId.startsWith("plugin:")) {
    try {
      const jsonStr = rawSessionId.slice("plugin:".length);
      const parsed = JSON.parse(jsonStr);
      const data = parsed?.data;
      if (data && typeof data === "object") {
        if (typeof data.conversationId === "string" && data.conversationId.length > 0) {
          cliId = data.conversationId;
        } else if (typeof data.sessionId === "string" && data.sessionId.length > 0) {
          cliId = data.sessionId;
        } else if (typeof data.threadId === "string" && data.threadId.length > 0) {
          cliId = data.threadId;
        } else if (typeof data.id === "string" && data.id.length > 0) {
          cliId = data.id;
        }
      } else if (typeof data === "string" && data.length > 0) {
        cliId = data;
      }
    } catch {
      // 忽略 JSON 解析失败，走后续回退
    }
  }

  // 2. 检查 persistence.metadata.pluginProviderPersistence
  if (!cliId && agent.persistence?.metadata?.pluginProviderPersistence) {
    const meta = agent.persistence.metadata.pluginProviderPersistence as {
      data?: Record<string, unknown>;
    };
    const data = meta?.data;
    if (data && typeof data === "object") {
      if (typeof data.conversationId === "string" && data.conversationId.length > 0) {
        cliId = data.conversationId;
      } else if (typeof data.sessionId === "string" && data.sessionId.length > 0) {
        cliId = data.sessionId;
      }
    }
  }

  // 3. 检查原生 session ID (非 plugin: 格式)
  if (!cliId && rawSessionId && !rawSessionId.startsWith("plugin:")) {
    cliId = rawSessionId;
  }

  // 4. 回退检查 nativeHandle
  if (!cliId && nativeHandle) {
    cliId = nativeHandle;
  }

  // 5. 生成对应的 CLI 恢复命令
  let resumeCommand: string | null = null;
  if (cliId) {
    if (p.includes("antigravity") || p === "agy") {
      resumeCommand = `agy --conversation ${cliId}`;
    } else if (p.includes("claude")) {
      resumeCommand = `claude --resume ${cliId}`;
    } else if (p.includes("codex")) {
      resumeCommand = `codex resume ${cliId}`;
    } else if (p.includes("hermes")) {
      resumeCommand = `hermes --resume ${cliId}`;
    } else if (p.includes("pi")) {
      resumeCommand = `pi --session ${cliId}`;
    } else if (p.includes("omp")) {
      resumeCommand = `omp --session ${cliId}`;
    } else if (p.includes("opencode")) {
      resumeCommand = `opencode --session ${cliId}`;
    }
  }

  return {
    paseoId,
    provider,
    cliId,
    rawSessionId,
    nativeHandle,
    resumeCommand,
    providerNote,
  };
}

/**
 * 格式化短 ID：左侧前缀 + ****** + 右侧 8 位
 * 例如: 0fd1ef10-9daa-42ab-a099-d76753ebbfe1 -> 0fd1ef10-9daa-******53ebbfe1
 */
function formatMaskedId(id: string | null, placeholder = "生成中..."): string {
  if (!id) return placeholder;
  if (id.length <= 22) return id;
  const head = id.slice(0, 13);
  const tail = id.slice(-8);
  const sep = head.endsWith("-") ? "" : "-";
  return `${head}${sep}******${tail}`;
}

/**
 * 格式化短 Resume 命令：保留命令前缀 + ****** + 会话末尾 8 位
 * 例如:
 * - agy --conversation 0fd1ef10-9daa-42ab-a099-d76753ebbfe1 -> agy --conversation ******53ebbfe1
 * - claude --resume 8a49abaa-edbc-439c-b4e1-f30e4da49111 -> claude --resume ******f30e4da4
 */
function formatMaskedResume(cmd: string | null): string {
  if (!cmd) return "";
  const parts = cmd.trim().split(/\s+/);
  if (parts.length <= 1) return cmd;
  const prefix = parts.slice(0, -1).join(" ");
  const last = parts[parts.length - 1];
  const tail = last.length > 8 ? last.slice(-8) : last;
  return `${prefix} ******${tail}`;
}

/**
 * 点击 Composer Pill 展开的 Popover 面板
 */
function SessionIdsPopover(props: PluginButtonContentProps) {
  const agentId = props.context === "agent" ? props.agentId : "";
  const { theme, layout } = props;
  const isCompact = layout?.compact;
  const paseo = usePaseo();
  const toast = useToast();
  const { t } = useTranslation(messages);
  const [agent, setAgent] = useState<any>(null);

  const handle = useMemo(() => paseo.agents.ref(agentId), [paseo, agentId]);

  // 加载与实时订阅 Agent 数据
  useEffect(() => {
    if (!agentId) return;
    let active = true;
    const current = handle.current();
    if (current) {
      setAgent(current);
    }

    handle
      .refresh()
      .then((res) => {
        if (active && res?.agent) {
          setAgent(res.agent);
        }
      })
      .catch(() => {});

    const unsubscribe = handle.subscribe((update) => {
      if (active && update.kind === "upsert" && update.agent.id === agentId) {
        setAgent(update.agent);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [handle, agentId]);

  const info = useMemo(() => {
    return parseAgentSession(agent ?? { id: agentId, provider: "loading..." });
  }, [agent, agentId]);

  const handleCopyPaseoId = useCallback(async () => {
    try {
      await copyText(info.paseoId);
      toast.show(t("copiedPaseo"), { variant: "success" });
    } catch {
      toast.error(t("copyFailed"));
    }
  }, [info.paseoId, toast, t]);

  const handleCopyCliId = useCallback(async () => {
    if (!info.cliId) {
      toast.show(t("cliPending"), { variant: "warning" });
      return;
    }
    try {
      await copyText(info.cliId);
      toast.show(t("copiedCli", { provider: info.provider }), { variant: "success" });
    } catch {
      toast.error(t("copyFailed"));
    }
  }, [info.cliId, info.provider, toast, t]);

  const handleCopyResumeCommand = useCallback(async () => {
    if (!info.resumeCommand) return;
    try {
      await copyText(info.resumeCommand);
      toast.show(t("copiedResume"), { variant: "success" });
    } catch {
      toast.error(t("copyFailed"));
    }
  }, [info.resumeCommand, toast, t]);

  const styles = useMemo(
    () => ({
      container: {
        width: isCompact ? "100%" : 290,
        gap: 3,
        paddingVertical: 1,
        paddingHorizontal: isCompact ? 8 : 1,
      },
      itemRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 6,
        paddingVertical: 5,
        paddingHorizontal: 4,
        borderRadius: 4,
      },
      itemLabel: {
        width: 48,
        fontSize: 11,
        fontWeight: "500" as const,
        color: theme.colors.foregroundMuted,
      },
      itemValue: {
        flex: 1,
        fontSize: 11,
        fontFamily: "monospace",
        color: theme.colors.foreground,
      },
      copyText: {
        fontSize: 11,
        color: theme.colors.accent,
        fontWeight: "500" as const,
      },
    }),
    [theme, isCompact],
  );

  return (
    <View style={styles.container}>
      {/* Paseo ID */}
      <Pressable style={styles.itemRow} onPress={handleCopyPaseoId}>
        <Text style={styles.itemLabel}>Paseo</Text>
        <Text style={styles.itemValue} numberOfLines={1}>
          {formatMaskedId(info.paseoId, t("generating"))}
        </Text>
        <Text style={styles.copyText}>{t("copyBtn")}</Text>
      </Pressable>

      {/* CLI ID */}
      <Pressable
        style={styles.itemRow}
        onPress={handleCopyCliId}
        disabled={!info.cliId}
      >
        <Text style={styles.itemLabel}>CLI</Text>
        <Text
          style={[
            styles.itemValue,
            !info.cliId && { color: theme.colors.foregroundMuted, fontStyle: "italic" },
          ]}
          numberOfLines={1}
        >
          {formatMaskedId(info.cliId, t("generating"))}
        </Text>
        <Text style={[styles.copyText, !info.cliId && { opacity: 0.3 }]}>{t("copyBtn")}</Text>
      </Pressable>

      {/* CLI 恢复命令 */}
      {info.resumeCommand ? (
        <Pressable style={styles.itemRow} onPress={handleCopyResumeCommand}>
          <Text style={styles.itemLabel}>Resume</Text>
          <Text style={styles.itemValue} numberOfLines={1}>
            {formatMaskedResume(info.resumeCommand)}
          </Text>
          <Text style={styles.copyText}>{t("copyBtn")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * 插件入口注册
 */
export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();

  // 为每个 Agent 注册输入框追踪条按钮 (Composer Pill)
  const registerPill = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;

    pills.get(agentId)?.remove();
    pills.set(
      agentId,
      client.addComposerPill({
        id: "session-ids",
        workspaceId,
        agentId,
        button: {
          title: messages.message("buttonTitle"),
          icon: "Fingerprint",
          label: messages.message("buttonLabel"),
          behavior: {
            kind: "popover",
            Content: SessionIdsPopover,
          },
        },
      }),
    );
  };

  const removeAllPills = () => {
    for (const pill of pills.values()) {
      pill.remove();
    }
    pills.clear();
  };

  // 监听并保持所有活跃 Agent 的 Composer Pill 注册
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAllPills();
          for (const { agent } of entries) {
            registerPill(agent);
          }
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            registerPill(update.agent);
          } else {
            pills.get(update.agentId)?.remove();
            pills.delete(update.agentId);
          }
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) {
        console.error("[session-ids] Agent 列表订阅失败:", error);
      }
    });

  // 注册斜杠命令 /ids
  client.addSlashCommand({
    name: "ids",
    description: messages.message("slashDescription"),
    argumentHint: "",
    context: "agent",
    async onSubmit({ agent, paseo }) {
      const handle = paseo.agents.ref(agent.id);
      let current = handle.current();
      if (!current?.persistence?.sessionId) {
        const refetched = await handle.refresh();
        if (refetched?.agent) {
          current = refetched.agent;
        }
      }
      const info = parseAgentSession(current ?? agent);
      const lines = [
        `Paseo ID: ${info.paseoId}`,
        `CLI ID: ${info.cliId ?? "(尚未生成)"}`,
        `Provider: ${info.provider}`,
      ];
      if (info.resumeCommand) {
        lines.push(`Resume: ${info.resumeCommand}`);
      }
      await copyText(lines.join("\n"));
    },
  });

  // 注册快捷命令中心项 (Cmd+K)
  client.addCommandCenterItem({
    id: "copy-session-ids",
    title: messages.message("commandTitle"),
    icon: "Fingerprint",
    context: "agent",
    async onSelect({ agent, paseo }: PluginAgentCommandContext) {
      const handle = paseo.agents.ref(agent.id);
      let current = handle.current();
      if (!current?.persistence?.sessionId) {
        const refetched = await handle.refresh();
        if (refetched?.agent) {
          current = refetched.agent;
        }
      }
      const info = parseAgentSession(current ?? agent);
      const lines = [
        `Paseo ID: ${info.paseoId}`,
        `CLI ID: ${info.cliId ?? "(尚未生成)"}`,
        `Provider: ${info.provider}`,
      ];
      if (info.resumeCommand) {
        lines.push(`Resume: ${info.resumeCommand}`);
      }
      await copyText(lines.join("\n"));
    },
  });

  return () => {
    lifetime.abort();
    removeAllPills();
  };
}
