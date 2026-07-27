import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	category: "auth" | "model" | "pi" | "session" | "settings" | "thread";
	argumentHint?: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu", category: "settings" },
	{
		name: "model",
		description: "Select model (opens selector UI)",
		category: "model",
		argumentHint: "<provider/model>",
	},
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling", category: "model" },
	{
		name: "export",
		description: "Export session (HTML default, or specify path: .html/.jsonl)",
		category: "session",
	},
	{ name: "import", description: "Import and resume a session from a JSONL file", category: "session" },
	{ name: "share", description: "Share session as a secret GitHub gist", category: "session" },
	{ name: "copy", description: "Copy last agent message to clipboard", category: "session" },
	{ name: "name", description: "Set session display name", category: "session" },
	{ name: "session", description: "Show session info and stats", category: "session" },
	{ name: "changelog", description: "Show changelog entries", category: "pi" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts", category: "pi" },
	{ name: "fork", description: "Create a new fork from a previous user message", category: "thread" },
	{ name: "clone", description: "Duplicate the current session at the current position", category: "thread" },
	{ name: "tree", description: "Navigate session tree (switch branches)", category: "thread" },
	{ name: "trust", description: "Save project trust decision for future sessions", category: "settings" },
	{
		name: "login",
		description: "Configure provider authentication",
		category: "auth",
		argumentHint: "<provider>",
	},
	{ name: "logout", description: "Remove provider authentication", category: "auth" },
	{ name: "new", description: "Start a new session", category: "thread" },
	{ name: "compact", description: "Manually compact the session context", category: "thread" },
	{ name: "resume", description: "Resume a different session", category: "thread" },
	{
		name: "reload",
		description: "Reload keybindings, extensions, skills, prompts, themes, and context files",
		category: "pi",
	},
	{ name: "quit", description: `Quit ${APP_NAME}`, category: "pi" },
];
