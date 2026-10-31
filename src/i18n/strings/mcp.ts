/**
 * The AI agents (MCP) control in the VMC window (src/app/mcpBridge.ts; the
 * English mirrors its MCP_STRINGS defaults). Tool results sent to agents stay
 * English and are not here.
 */
import type { Tr } from '../types';

export const en = {
  'mcp.title': 'AI AGENTS (MCP)',
  'mcp.enable': 'ALLOW AI AGENTS (LOCAL MCP SERVER)',
  'mcp.enableTitle': 'Lets Claude Code, Claude Desktop, Cursor and other MCP clients on this computer inspect and drive VPuppet',
  'mcp.port': 'PORT',
  'mcp.state': 'STATE',
  'mcp.off': 'OFF',
  'mcp.starting': 'STARTING…',
  'mcp.running': 'ON {url}',
  'mcp.calls': '{n} CALLS · LAST {tool}',
  'mcp.error': 'ERROR: {error}',
  'mcp.desktopOnly': 'DESKTOP APP ONLY',
  'mcp.hint': 'Local only (127.0.0.1) and every request needs the token in VPuppet’s config folder. To connect your agents, run the install command in a terminal.',
  'mcp.copyInstall': 'COPY INSTALL COMMAND',
  'mcp.copyClaude': 'COPY CLAUDE CODE COMMAND',
  'mcp.copyClaudeTitle': 'claude mcp add … with the token (keep it private)',
  'mcp.reset': 'NEW TOKEN',
  'mcp.resetTitle': 'Replace the token: connected agents stop working until you run the install command again',
  'mcp.copied': 'COPIED',
} as const;

export const ru: Tr<typeof en> = {
  'mcp.title': 'ИИ-АГЕНТЫ (MCP)',
  'mcp.enable': 'РАЗРЕШИТЬ ИИ-АГЕНТОВ (ЛОКАЛЬНЫЙ СЕРВЕР MCP)',
  'mcp.enableTitle': 'Позволяет Claude Code, Claude Desktop, Cursor и другим MCP-клиентам на этом компьютере просматривать VPuppet и управлять им',
  'mcp.port': 'ПОРТ',
  'mcp.state': 'СОСТОЯНИЕ',
  'mcp.off': 'ВЫКЛ',
  'mcp.starting': 'ЗАПУСК…',
  'mcp.running': 'ВКЛ {url}',
  'mcp.calls': 'ВЫЗОВОВ: {n} · ПОСЛЕДНИЙ {tool}',
  'mcp.error': 'ОШИБКА: {error}',
  'mcp.desktopOnly': 'ТОЛЬКО В ПРИЛОЖЕНИИ',
  'mcp.hint': 'Только локально (127.0.0.1), и каждый запрос требует токен из папки настроек VPuppet. Чтобы подключить агентов, выполните команду установки в терминале.',
  'mcp.copyInstall': 'КОПИРОВАТЬ КОМАНДУ УСТАНОВКИ',
  'mcp.copyClaude': 'КОПИРОВАТЬ КОМАНДУ CLAUDE CODE',
  'mcp.copyClaudeTitle': 'claude mcp add … с токеном (не показывайте его никому)',
  'mcp.reset': 'НОВЫЙ ТОКЕН',
  'mcp.resetTitle': 'Заменить токен: подключённые агенты перестанут работать, пока вы снова не выполните команду установки',
  'mcp.copied': 'СКОПИРОВАНО',
};

export const zhCN: Tr<typeof en> = {
  'mcp.title': 'AI 智能体（MCP）',
  'mcp.enable': '允许 AI 智能体（本地 MCP 服务器）',
  'mcp.enableTitle': '允许本机上的 Claude Code、Claude Desktop、Cursor 等 MCP 客户端查看并操控 VPuppet',
  'mcp.port': '端口',
  'mcp.state': '状态',
  'mcp.off': '关',
  'mcp.starting': '启动中…',
  'mcp.running': '已开启 {url}',
  'mcp.calls': '调用 {n} 次 · 最近 {tool}',
  'mcp.error': '错误：{error}',
  'mcp.desktopOnly': '仅限桌面应用',
  'mcp.hint': '仅限本机（127.0.0.1），每个请求都需要 VPuppet 配置文件夹中的令牌。要连接你的智能体，请在终端中运行安装命令。',
  'mcp.copyInstall': '复制安装命令',
  'mcp.copyClaude': '复制 CLAUDE CODE 命令',
  'mcp.copyClaudeTitle': '包含令牌的 claude mcp add …（请勿泄露）',
  'mcp.reset': '新令牌',
  'mcp.resetTitle': '更换令牌：已连接的智能体将停止工作，直到你重新运行安装命令',
  'mcp.copied': '已复制',
};

export const es: Tr<typeof en> = {
  'mcp.title': 'AGENTES DE IA (MCP)',
  'mcp.enable': 'PERMITIR AGENTES DE IA (SERVIDOR MCP LOCAL)',
  'mcp.enableTitle': 'Permite que Claude Code, Claude Desktop, Cursor y otros clientes MCP de este equipo inspeccionen y controlen VPuppet',
  'mcp.port': 'PUERTO',
  'mcp.state': 'ESTADO',
  'mcp.off': 'OFF',
  'mcp.starting': 'INICIANDO…',
  'mcp.running': 'ON {url}',
  'mcp.calls': '{n} LLAMADAS · ÚLTIMA {tool}',
  'mcp.error': 'ERROR: {error}',
  'mcp.desktopOnly': 'SOLO EN LA APP DE ESCRITORIO',
  'mcp.hint': 'Solo local (127.0.0.1) y cada petición necesita el token de la carpeta de configuración de VPuppet. Para conectar tus agentes, ejecuta el comando de instalación en una terminal.',
  'mcp.copyInstall': 'COPIAR COMANDO DE INSTALACIÓN',
  'mcp.copyClaude': 'COPIAR COMANDO DE CLAUDE CODE',
  'mcp.copyClaudeTitle': 'claude mcp add … con el token (no lo compartas)',
  'mcp.reset': 'NUEVO TOKEN',
  'mcp.resetTitle': 'Sustituir el token: los agentes conectados dejarán de funcionar hasta que vuelvas a ejecutar el comando de instalación',
  'mcp.copied': 'COPIADO',
};
