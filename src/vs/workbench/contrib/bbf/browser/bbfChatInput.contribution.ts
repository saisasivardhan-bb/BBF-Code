/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { BBF_DEEP_REASONING_SETTING, BBF_DEEP_REASONING_TOGGLE_ACTION_ID, BBF_EFFORT_PICKER_ACTION_ID, BBF_PERMISSION_MODE_PICKER_ACTION_ID } from '../../chat/browser/widget/input/bbfSettingPickerActionItem.js';

/**
 * The BBF chips in the chat input's secondary toolbar.
 *
 * They replace the upstream "Local" session-target and delegation chips (BBF
 * Code has a single, local target) and the generic permission-level chip.
 * Deep Reasoning is a toggle; Effort and Permissions are pickers rendered by
 * `BbfSettingPickerActionItem`, which is what the chat input creates for those
 * action ids, so their `run` methods are intentionally empty.
 */
const inChatInput = ContextKeyExpr.and(
	ChatContextKeys.enabled,
	ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat),
	ChatContextKeys.inQuickChat.negate(),
);

const deepReasoningOn = ContextKeyExpr.equals(`config.${BBF_DEEP_REASONING_SETTING}`, true);

class ToggleBbfDeepReasoningAction extends Action2 {
	constructor() {
		super({
			id: BBF_DEEP_REASONING_TOGGLE_ACTION_ID,
			title: localize2('bbf.deepReasoning', "Deep Reasoning"),
			tooltip: localize('bbf.deepReasoning.tooltip', "Let the model think before it answers. Off asks for a direct answer."),
			icon: Codicon.lightbulb,
			toggled: deepReasoningOn,
			f1: false,
			precondition: ChatContextKeys.enabled,
			menu: [{
				id: MenuId.ChatInputSecondary,
				group: 'navigation',
				order: 0.4,
				when: inChatInput,
			}],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const on = configurationService.getValue<boolean>(BBF_DEEP_REASONING_SETTING) !== false;
		await configurationService.updateValue(BBF_DEEP_REASONING_SETTING, !on);
	}
}

class OpenBbfEffortPickerAction extends Action2 {
	constructor() {
		super({
			id: BBF_EFFORT_PICKER_ACTION_ID,
			title: localize2('bbf.effortPicker', "Effort"),
			f1: false,
			precondition: ChatContextKeys.enabled,
			menu: [{
				id: MenuId.ChatInputSecondary,
				group: 'navigation',
				order: 0.5,
				// Effort only shapes a turn while the model is asked to reason.
				when: ContextKeyExpr.and(inChatInput, deepReasoningOn),
			}],
		});
	}

	override async run(): Promise<void> { /* the picker item handles interaction */ }
}

class OpenBbfPermissionModePickerAction extends Action2 {
	constructor() {
		super({
			id: BBF_PERMISSION_MODE_PICKER_ACTION_ID,
			title: localize2('bbf.permissionModePicker', "Permission Mode"),
			f1: false,
			precondition: ChatContextKeys.enabled,
			menu: [{
				id: MenuId.ChatInputSecondary,
				group: 'navigation',
				order: 1,
				when: inChatInput,
			}],
		});
	}

	override async run(): Promise<void> { /* the picker item handles interaction */ }
}

registerAction2(ToggleBbfDeepReasoningAction);
registerAction2(OpenBbfEffortPickerAction);
registerAction2(OpenBbfPermissionModePickerAction);
