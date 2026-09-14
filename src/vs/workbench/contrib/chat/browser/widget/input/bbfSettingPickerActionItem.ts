/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Blackbox Factories. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/bbfChips.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { ActionViewItem } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { renderLabelWithIcons } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { MenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction, IActionWidgetDropdownActionProvider } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { ChatInputPickerActionViewItem, IChatInputPickerOptions } from './chatInputPickerActionItem.js';

export const BBF_EFFORT_PICKER_ACTION_ID = 'workbench.action.chat.bbf.openEffortPicker';
export const BBF_PERMISSION_MODE_PICKER_ACTION_ID = 'workbench.action.chat.bbf.openPermissionModePicker';
export const BBF_DEEP_REASONING_TOGGLE_ACTION_ID = 'workbench.action.chat.bbf.toggleDeepReasoning';

/** The extension's setting behind the Deep Reasoning toggle; Effort only applies while it is on. */
export const BBF_DEEP_REASONING_SETTING = 'bbf.aiCoder.deepReasoning';

/**
 * A chip that flips a boolean setting on click, drawn like the pickers around
 * it. The action's `toggled` expression supplies the on/off state, so the chip
 * follows the setting wherever it is changed.
 */
export class BbfToggleChipActionItem extends ActionViewItem {

	constructor(action: MenuItemAction) {
		super(undefined, action, { icon: true, label: true });
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('chat-input-picker-item', 'bbf-toggle-chip');
	}
}

/** One option a BBF chip offers. */
export interface IBbfSettingPickerChoice {
	/** The value written to the setting. */
	readonly id: string;
	readonly label: string;
	/** What the chip itself shows when there is room for text. */
	readonly shortLabel: string;
	readonly detail: string;
	readonly icon: ThemeIcon;
}

/** A chip that is a thin view over one user setting. */
export interface IBbfSettingPickerSpec {
	readonly settingId: string;
	/** Heading shown above the choices in the dropdown. */
	readonly category: string;
	readonly defaultId: string;
	readonly choices: readonly IBbfSettingPickerChoice[];
}

/**
 * The BBF chips are backed by settings rather than by session state on
 * purpose: the extension that drives the engine reads the same settings on
 * every request, so the setting is the single contract between the two and
 * there is nothing to keep in sync.
 */
const EFFORT_SPEC: IBbfSettingPickerSpec = {
	settingId: 'bbf.aiCoder.effort',
	category: localize('bbf.effort.category', "Effort"),
	defaultId: 'medium',
	choices: [
		{
			id: 'low',
			label: localize('bbf.effort.low', "Low"),
			shortLabel: localize('bbf.effort.low.short', "Low"),
			detail: localize('bbf.effort.low.detail', "Quick answers with minimal reasoning"),
			icon: Codicon.dashboard,
		},
		{
			id: 'medium',
			label: localize('bbf.effort.medium', "Medium"),
			shortLabel: localize('bbf.effort.medium.short', "Med"),
			detail: localize('bbf.effort.medium.detail', "The model's default balance of speed and depth"),
			icon: Codicon.dashboard,
		},
		{
			id: 'max',
			label: localize('bbf.effort.max', "Max"),
			shortLabel: localize('bbf.effort.max.short', "Max"),
			detail: localize('bbf.effort.max.detail', "Deepest reasoning; slower and most thorough"),
			icon: Codicon.dashboard,
		},
	],
};

const PERMISSION_MODE_SPEC: IBbfSettingPickerSpec = {
	settingId: 'bbf.aiCoder.permissionMode',
	category: localize('bbf.permissionMode.category', "Permissions"),
	defaultId: 'manual',
	choices: [
		{
			id: 'manual',
			label: localize('bbf.permissionMode.manual', "Manual"),
			shortLabel: localize('bbf.permissionMode.manual.short', "Manual"),
			detail: localize('bbf.permissionMode.manual.detail', "Ask before every file edit, command and search"),
			icon: Codicon.shield,
		},
		{
			id: 'auto',
			label: localize('bbf.permissionMode.auto', "Auto"),
			shortLabel: localize('bbf.permissionMode.auto.short', "Auto"),
			detail: localize('bbf.permissionMode.auto.detail', "BBF AI Coder decides on its own; every action is still recorded in the chat"),
			icon: Codicon.zap,
		},
	],
};

/** The chip specification for one of the BBF picker action ids, if it is one. */
export function getBbfSettingPickerSpec(actionId: string): IBbfSettingPickerSpec | undefined {
	switch (actionId) {
		case BBF_EFFORT_PICKER_ACTION_ID:
			return EFFORT_SPEC;
		case BBF_PERMISSION_MODE_PICKER_ACTION_ID:
			return PERMISSION_MODE_SPEC;
		default:
			return undefined;
	}
}

/**
 * A chat input chip whose dropdown writes one setting and whose label mirrors
 * the setting's current value.
 */
export class BbfSettingPickerActionItem extends ChatInputPickerActionViewItem {

	constructor(
		action: MenuItemAction,
		private readonly spec: IBbfSettingPickerSpec,
		pickerOptions: IChatInputPickerOptions,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		const actionProvider: IActionWidgetDropdownActionProvider = {
			getActions: () => {
				const current = configurationService.getValue<string>(spec.settingId) ?? spec.defaultId;
				return spec.choices.map(choice => ({
					...action,
					id: `${action.id}.${choice.id}`,
					label: choice.label,
					detail: choice.detail,
					icon: choice.icon,
					checked: choice.id === current,
					enabled: true,
					tooltip: '',
					category: { label: spec.category, order: 1 },
					run: async () => {
						await configurationService.updateValue(spec.settingId, choice.id);
					},
				} satisfies IActionWidgetDropdownAction));
			}
		};

		super(action, { actionProvider, showItemKeybindings: false }, pickerOptions, actionWidgetService, keybindingService, contextKeyService, telemetryService);

		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(spec.settingId) && this.element) {
				this.renderLabel(this.element);
			}
		}));
	}

	private current(): IBbfSettingPickerChoice {
		const value = this.configurationService.getValue<string>(this.spec.settingId);
		return this.spec.choices.find(choice => choice.id === value)
			?? this.spec.choices.find(choice => choice.id === this.spec.defaultId)
			?? this.spec.choices[0];
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		this.setAriaLabelAttributes(element);
		const choice = this.current();
		const compact = this.pickerOptions.compact.get();
		dom.reset(element, ...renderLabelWithIcons(compact
			? `$(${choice.icon.id})`
			: `$(${choice.icon.id}) ${choice.shortLabel}`));
		element.ariaLabel = localize('bbf.picker.ariaLabel', "{0}: {1}", this.spec.category, choice.label);
		return null;
	}
}
