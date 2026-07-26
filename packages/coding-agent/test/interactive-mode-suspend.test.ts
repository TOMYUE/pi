import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type FakeUi = {
	start: () => void;
	stop: () => void;
	requestRender: (force?: boolean) => void;
};

type HandleCtrlZThis = {
	ui: FakeUi;
	isSuspended: boolean;
};

type ProcessSignalHandler = () => void;

type InteractiveModePrototypeWithHandleCtrlZ = {
	handleCtrlZ(this: HandleCtrlZThis): void;
};

type RegisterSignalHandlersThis = {
	isSuspended: boolean;
	signalCleanupHandlers: Array<() => void>;
	unregisterSignalHandlers: () => void;
	shutdown: (options: { fromSignal: boolean }) => Promise<void>;
	emergencyTerminalExit: () => never;
	uncaughtCrash: (error: Error) => never;
};

type UncaughtCrashThis = {
	isShuttingDown: boolean;
	ui: { stop: () => void };
	unregisterSignalHandlers: () => void;
};

type InteractiveModePrototypeWithSignalHandlers = {
	registerSignalHandlers(this: RegisterSignalHandlersThis): void;
	uncaughtCrash(this: UncaughtCrashThis, error: Error): never;
};

class ProcessExitError extends Error {}

function callHandleCtrlZ(context: HandleCtrlZThis): void {
	(interactiveModePrototype as InteractiveModePrototypeWithHandleCtrlZ).handleCtrlZ.call(context);
}

const interactiveModePrototype = InteractiveMode.prototype as unknown;

describe("InteractiveMode.handleCtrlZ", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("shows a status message and skips suspend on Windows", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const showStatus = vi.fn();
		const context: HandleCtrlZThis & { showStatus: (message: string) => void } = {
			ui,
			isSuspended: false,
			showStatus,
		};
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "win32",
		});
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const processOnSpy = vi.spyOn(process, "on");
		const processOnceSpy = vi.spyOn(process, "once");
		const processKillSpy = vi.spyOn(process, "kill");

		try {
			callHandleCtrlZ(context);
		} finally {
			if (platformDescriptor) {
				Object.defineProperty(process, "platform", platformDescriptor);
			}
		}

		expect(showStatus).toHaveBeenCalledWith("Suspend to background is not supported on Windows");
		expect(ui.stop).not.toHaveBeenCalled();
		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(processOnSpy).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).not.toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(processKillSpy).not.toHaveBeenCalled();
	});

	test("keeps the process alive while suspended and restores the TUI on SIGCONT", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const context: HandleCtrlZThis = { ui, isSuspended: false };
		const keepAliveHandle = setTimeout(() => undefined, 0);
		clearTimeout(keepAliveHandle);

		let sigintHandler: ProcessSignalHandler | undefined;
		let sigcontHandler: ProcessSignalHandler | undefined;

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAliveHandle);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		const processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGINT") {
				sigintHandler = listener;
			}
			return process;
		}) as typeof process.on);
		const processOnceSpy = vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGCONT") {
				sigcontHandler = listener;
			}
			return process;
		}) as typeof process.once);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		callHandleCtrlZ(context);

		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2 ** 30);
		expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(processKillSpy).toHaveBeenCalledWith(0, "SIGTSTP");
		expect(sigintHandler).toBeDefined();
		expect(sigcontHandler).toBeDefined();
		expect(context.isSuspended).toBe(true);

		sigintHandler?.();
		expect(ui.start).not.toHaveBeenCalled();

		sigcontHandler?.();

		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", sigintHandler);
		expect(context.isSuspended).toBe(false);
		expect(ui.start).toHaveBeenCalledTimes(1);
		expect(ui.requestRender).toHaveBeenCalledWith(true);
	});

	test("cleans up the temporary handlers if suspension fails", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const context: HandleCtrlZThis = { ui, isSuspended: false };
		const keepAliveHandle = setTimeout(() => undefined, 0);
		clearTimeout(keepAliveHandle);
		const suspendError = new Error("suspend failed");

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAliveHandle);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		vi.spyOn(process, "on").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.on,
		);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		vi.spyOn(process, "once").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.once,
		);
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw suspendError;
		});

		expect(() => callHandleCtrlZ(context)).toThrow(suspendError);
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(context.isSuspended).toBe(false);
		expect(ui.start).not.toHaveBeenCalled();
		expect(ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode signal handling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("handles SIGINT gracefully while active and suppresses it while suspended", () => {
		let sigintHandler: ProcessSignalHandler | undefined;
		const context: RegisterSignalHandlersThis = {
			isSuspended: false,
			signalCleanupHandlers: [],
			unregisterSignalHandlers: vi.fn(),
			shutdown: vi.fn(async () => {}),
			emergencyTerminalExit: vi.fn(() => {
				throw new Error("unexpected emergency exit");
			}),
			uncaughtCrash: vi.fn(() => {
				throw new Error("unexpected crash");
			}),
		};
		vi.spyOn(process, "prependListener").mockImplementation(((event, listener) => {
			if (event === "SIGINT") sigintHandler = listener as ProcessSignalHandler;
			return process;
		}) as typeof process.prependListener);
		vi.spyOn(process.stdout, "on").mockImplementation((() => process.stdout) as typeof process.stdout.on);
		vi.spyOn(process.stderr, "on").mockImplementation((() => process.stderr) as typeof process.stderr.on);

		(interactiveModePrototype as InteractiveModePrototypeWithSignalHandlers).registerSignalHandlers.call(context);
		expect(sigintHandler).toBeDefined();

		sigintHandler?.();
		expect(context.shutdown).toHaveBeenCalledWith({ fromSignal: true });

		vi.mocked(context.shutdown).mockClear();
		context.isSuspended = true;
		sigintHandler?.();
		expect(context.shutdown).not.toHaveBeenCalled();
	});

	test("restores the TUI for an uncaught crash during shutdown", () => {
		const context: UncaughtCrashThis = {
			isShuttingDown: true,
			ui: { stop: vi.fn() },
			unregisterSignalHandlers: vi.fn(),
		};
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);

		expect(() =>
			(interactiveModePrototype as InteractiveModePrototypeWithSignalHandlers).uncaughtCrash.call(
				context,
				new Error("shutdown failed"),
			),
		).toThrow(ProcessExitError);
		expect(context.ui.stop).toHaveBeenCalledTimes(1);
	});
});
