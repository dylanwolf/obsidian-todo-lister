import {
	App,
	IconName,
	ItemView,
	MarkdownView,
	Plugin,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
var removeMd = require("remove-markdown");

interface ToDoListerPluginSettings {}

const DEFAULT_SETTINGS: ToDoListerPluginSettings = {};

export default class ToDoListerPlugin extends Plugin {
	settings: ToDoListerPluginSettings;

	async onload() {
		await this.loadSettings();

		// Register the TODO List view
		this.registerView(VIEW_TYPE_ID, (leaf) => new ToDoListTab(leaf));

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon(
			"clipboard-list",
			"Open TODO Lister",
			(evt: MouseEvent) => {
				this.activateView();
			}
		);

		// Register a command to open the TODO List view
		this.addCommand({
			id: "todo-lister-open-listview",
			name: "Open TODO Lister",
			icon: "clipboard-list",
			checkCallback: (checking: boolean) => {
				this.activateView();
				return true;
			},
		});
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async activateView() {
		const { workspace } = this.app;

		// When the view is activated, return any existing leaves that match it
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_ID);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			leaf = workspace.getRightLeaf(false);
			if (leaf != null)
				await leaf.setViewState({ type: VIEW_TYPE_ID, active: true });
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (leaf != null) workspace.revealLeaf(leaf);
	}
}

const VIEW_TYPE_ID = "todo-lister-listview";

class ToDoListTab extends ItemView {
	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getIcon(): IconName {
		return "clipboard-list";
	}

	getViewType(): string {
		return VIEW_TYPE_ID;
	}

	getDisplayText(): string {
		return "TODO Lister";
	}

	protected async onOpen(): Promise<void> {
		// Clear the top-level HTML element in the view
		const container = this.containerEl;
		container.empty();

		// Search all markdown files in the vault for TODO: entries
		// Sort by filename and order in file
		var toDoItems = (
			await getToDoGroupsFromFiles(
				this.app,
				this.app.vault.getMarkdownFiles()
			)
		).sort(toDoGroupSorter);

		toDoItems.forEach((i) => {
			buildToDoItemList(this.app, container, i);
		});
	}
}

async function openFile(app: App, file: TFile): Promise<void> {
	// Look at all open markdown leaves
	var leaves = app.workspace.getLeavesOfType("markdown");

	// Find a leaf with the selected path, if it exists
	var matchingLeaf = leaves.filter(
		(l) => (l.view as MarkdownView)?.file?.path === file.path
	)[0];

	if (matchingLeaf) {
		// If we found a matching leaf, activate it
		app.workspace.setActiveLeaf(matchingLeaf);
	} else {
		// Otherwise, create a new leaf and open the selected file
		var newLeaf = app.workspace.getLeaf(false);
		await newLeaf.openFile(file);
	}
}

interface IToDoGroup {
	file: TFile;
	items: string[];
}

function buildToDoItemList(app: App, container: HTMLElement, grp: IToDoGroup) {
	// Create header as a link
	var header = container.createEl("h5");
	var link = header.createEl("a", { text: grp.file.basename });
	link.addEventListener("click", async () => openFile(app, grp.file));

	// Create list
	var ul = container.createEl("ul");
	grp.items.forEach((i) => ul.createEl("li", { text: i }));
}

function toDoGroupSorter(us: IToDoGroup, them: IToDoGroup) {
	return us.file.basename === them.file.basename
		? 0
		: us.file.basename > them.file.basename
		? 1
		: -1;
}

async function getToDoGroupsFromFiles(
	app: App,
	files: TFile[]
): Promise<IToDoGroup[]> {
	// Parse all files in the list and return any TODO entries
	return (
		await Promise.all(files.map(async (f) => getToDoGroupFromFile(app, f)))
	).filter((grp) => grp.items.length > 0);
}

async function getToDoGroupFromFile(
	app: App,
	file: TFile
): Promise<IToDoGroup> {
	// Get the file contents
	var md = await app.vault.adapter.read(file.path);
	var txt = removeMd(md);

	// Search for any lines where TODO: appears. Clear any formatting around it and read to the end of the line.
	var matches = [...txt.matchAll(/^.*TODO\s*:\s*(.+?)$/gm)]
		.concat([...txt.matchAll(/^(.+?)\s+TODO\s*$/gm)])
		.filter((m) => m[1]);

	return {
		file: file,
		items: (matches || [])
			.map((m) => m[1]?.trim())
			.filter((x) => x && x !== ""),
	};
}
