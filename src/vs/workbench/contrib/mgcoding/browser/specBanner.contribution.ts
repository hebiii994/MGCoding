/*---------------------------------------------------------------------------------------------
 *  MGCoding - barra "Spec" in alto (Requirements / Design / Task list · Sync · Continue)
 *  Mostra un banner quando è attivo un file di una spec (.mg/specs o .kiro/specs).
 *--------------------------------------------------------------------------------------------*/

import './media/specBanner.css';
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

	/** Rende leggibile lo slug della cartella spec (trattini → spazi, prima lettera maiuscola). */
	private prettyName(slug: string): string {
		const s = slug.replace(/[-_]+/g, ' ').trim();
		return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Spec';
	}

	/** Fase corrente in base al file aperto. */
	private phaseOf(path: string): 'requirements' | 'design' | 'tasks' {
		if (/requirements\.md$/i.test(path)) { return 'requirements'; }
		if (/design\.md$/i.test(path)) { return 'design'; }
		return 'tasks';
	}

	private update(): void {
		const resource = this.editorService.activeEditor?.resource;
		const path = resource?.path ?? '';
		if (resource && SPEC_FILE_RE.test(path)) {
			const feature = this.featureName(path);
			const phase = this.phaseOf(path);
			// La fase attiva ha l'etichetta in grassetto (aggancio CSS per evidenziarla).
			const step = (active: boolean, label: string, cmd: string): string =>
				active ? `[**${label}**](command:${cmd})` : `[${label}](command:${cmd})`;
			const chevron = ' $(chevron-right) ';
			const message = new MarkdownString(
				`**${this.prettyName(feature)}** ` +
				step(phase === 'requirements', '1 Requirements', 'mgcoding.specOpenRequirements') + chevron +
				step(phase === 'design', '2 Design', 'mgcoding.specOpenDesign') + chevron +
				step(phase === 'tasks', '3 Task list', 'mgcoding.specOpenTasks') +
				` [$(sync) Sync Files](command:mgcoding.specSync)` +
				` [$(run-all) Continue](command:mgcoding.runSpecTasksHere)`,
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
