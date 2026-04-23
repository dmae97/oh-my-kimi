import type { PythonKernelExecutor } from "@oh-my-pi/pi-coding-agent/ipy/executor";
import type { KernelExecuteOptions, KernelExecuteResult } from "@oh-my-pi/pi-coding-agent/ipy/kernel";

export class FakeKernel implements PythonKernelExecutor {
	private result: KernelExecuteResult;
	private onExecute: (options?: KernelExecuteOptions) => Promise<void> | void;

	constructor(result: KernelExecuteResult, onExecute: (options?: KernelExecuteOptions) => Promise<void> | void) {
		this.result = result;
		this.onExecute = onExecute;
	}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		await this.onExecute(options);
		return this.result;
	}
}
