export const TASK_SIMPLE_MODES = ["default", "schema-free", "independent"] as const;

export type TaskSimpleMode = (typeof TASK_SIMPLE_MODES)[number];

interface TaskSimpleModeCapabilities {
	customSchemaEnabled: boolean;
}

const TASK_SIMPLE_MODE_CAPABILITIES: Record<TaskSimpleMode, TaskSimpleModeCapabilities> = {
	default: {
		customSchemaEnabled: true,
	},
	"schema-free": {
		customSchemaEnabled: false,
	},
	independent: {
		customSchemaEnabled: false,
	},
};

export function getTaskSimpleModeCapabilities(mode: TaskSimpleMode): TaskSimpleModeCapabilities {
	return TASK_SIMPLE_MODE_CAPABILITIES[mode];
}
