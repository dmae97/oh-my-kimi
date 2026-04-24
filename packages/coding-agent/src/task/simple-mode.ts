export const TASK_SIMPLE_MODES = ["default", "schema-free", "independent"] as const;

export type TaskSimpleMode = (typeof TASK_SIMPLE_MODES)[number];

interface TaskSimpleModeCapabilities {
	contextEnabled: boolean;
	customSchemaEnabled: boolean;
}

const TASK_SIMPLE_MODE_CAPABILITIES: Record<TaskSimpleMode, TaskSimpleModeCapabilities> = {
	default: {
		contextEnabled: true,
		customSchemaEnabled: true,
	},
	"schema-free": {
		contextEnabled: true,
		customSchemaEnabled: false,
	},
	independent: {
		contextEnabled: false,
		customSchemaEnabled: false,
	},
};

export function getTaskSimpleModeCapabilities(mode: TaskSimpleMode): TaskSimpleModeCapabilities {
	return TASK_SIMPLE_MODE_CAPABILITIES[mode];
}
