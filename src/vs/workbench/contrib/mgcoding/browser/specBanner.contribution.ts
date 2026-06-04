/*---------------------------------------------------------------------------------------------
 *  MGCoding - barra "Spec" in alto (Requirements / Design / Task list · Sync · Continue)
 *  Mostra un banner quando è attivo un file di una spec (.mg/specs o .kiro/specs).
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { IBannerService } from '../../../services/banner/browser/bannerService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

const BANNER_ID = 'mgcoding.specBanner';
const SPEC_FILE_RE = /[\\/]specs[\\/][^\\/]+[\\/](requirements|design|tasks)\.md$/i;

const SPEC_COMMANDS = [
	'mgcoding.specOpenRequirements',
	'mgcoding.specOpenDesign',
	'mgcoding.specOpenTasks',
	'mgcoding.specSync',
	'mgcoding.runSpecTasksHere'
];

class SpecBannerContribution extends Disposable implements IWorkbenchContribution {

	private shown = false;

	constructor(
		@IBannerService private readonly bannerService: IBannerService,
		@IEditorService private readonly editorService: IEditorService
	) {
		super();
		this._register(this.editorService.onDidActiveEditorChange(() => this.update()));
		this.update();
	}

	private featureName(path: string): string {
		const parts = path.split(/[\\/]/);
		const i = parts.lastIndexOf('specs');
		return (i >= 0 && parts[i + 1]) ? parts[i + 1] : 'spec';
	}

	private update(): void {
		const resource = this.editorService.activeEditor?.resource;
		const path = resource?.path ?? '';
		if (resource && SPEC_FILE_RE.test(path)) {
			const feature = this.featureName(path);
			const message = new MarkdownString(
				`$(checklist) **${feature}** &nbsp; ` +
				`[1 Requirements](command:mgcoding.specOpenRequirements) › ` +
				`[2 Design](command:mgcoding.specOpenDesign) › ` +
				`[3 Task list](command:mgcoding.specOpenTasks) &nbsp;&nbsp;·&nbsp;&nbsp; ` +
				`[$(sync) Sync Files](command:mgcoding.specSync) &nbsp; ` +
				`[$(run-all) Continue](command:mgcoding.runSpecTasksHere)`,
				{ isTrusted: { enabledCommands: SPEC_COMMANDS }, supportThemeIcons: true }
			);
			this.bannerService.show({
				id: BANNER_ID,
				icon: Codicon.checklist,
				message,
				ariaLabel: `Spec ${feature}: Requirements, Design, Task list, Sync, Continue`
			});
			this.shown = true;
		} else if (this.shown) {
			this.bannerService.hide(BANNER_ID);
			this.shown = false;
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(SpecBannerContribution, LifecyclePhase.Restored);
