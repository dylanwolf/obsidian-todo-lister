import {
	App,
	IconName,
	ItemView,
	MarkdownView,
	Plugin,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import * as path from "path";
var removeMd = require("remove-markdown");

// --------------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------------
interface ToDoListerPluginSettings {}
const DEFAULT_SETTINGS: ToDoListerPluginSettings = {};

// --------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------
function getMatchingLeaf(app: App, file: TAbstractFile) {
	return app.workspace
		.getLeavesOfType("markdown")
		.filter((l) => (l.view as MarkdownView)?.file?.path === file.path)[0];
}

// --------------------------------------------------------------------------------
// TO-DO Reader
// --------------------------------------------------------------------------------

interface IToDoGroup {
	file: TAbstractFile;
	items: string[];
}

function toDoGroupSorter(us: IToDoGroup, them: IToDoGroup) {
	return us.file.name === them.file.name
		? 0
		: us.file.name > them.file.name
		? 1
		: -1;
}

const TODO_REGEXES = [
	/^.*TODO\s*:\s*(.+?)$/,
	/^(.+?)\s+TODO\s*$/,
	/^(.+?[\s(]TODO[)\s].+?)$/,
];

class ToDoReader {
	private _dict: { [path: string]: IToDoGroup | null } = {};

	constructor() {}

	getFilesInOrder(): IToDoGroup[] {
		return Object.values(this._dict)
			.filter((x) => x !== null)
			.sort(toDoGroupSorter);
	}

	async loadAllFiles(app: App, files: TAbstractFile[]) {
		console.log("ToDoReader.loadAllFiles");
		return await Promise.all(
			files.map(async (f) => this.loadFileFromDisk(app, f))
		);
	}

	async updateFile(app: App, file: TAbstractFile) {
		console.log("ToDoReader.updateFile: " + file.path);
		this.loadFileFromWorkspace(app, file);
	}

	deleteFile(file: TAbstractFile) {
		console.log("ToDoReader.deleteFile: " + file.path);
		delete this._dict[file.path];
	}

	async renameFile(app: App, file: TAbstractFile, filename: string) {
		console.log("ToDoReader.renameFile: " + file.path + ", " + filename);
		delete this._dict[filename];
		this.updateFile(app, file);
	}

	protected async loadFileFromDisk(app: App, file: TAbstractFile) {
		if (path.extname(file.path) !== ".md") return;

		var md = await app.vault.adapter.read(file.path);
		this.loadFile(file, md);
	}

	protected async loadFileFromWorkspace(app: App, file: TAbstractFile) {
		var leaf = getMatchingLeaf(app, file);
		if (leaf) {
			var viewContent = (leaf.view as MarkdownView).editor.getValue();
			if (viewContent) {
				this.loadFile(file, viewContent);
				return;
			}
		}

		this.loadFileFromDisk(app, file);
	}

	private async loadFile(file: TAbstractFile, md: string) {
		// Strip out [[links]]
		md = md.replace(/\[\[([^\]]+)\]\]/g, "$1");
		// Remove markdown, leaving only plain text
		var txt = removeMd(md);

		// Search for any lines where TODO: appears. Clear any formatting around it and read to the end of the line.
		var lines: string[] = txt.split(/\r?\n/).map((x: string) => x.trim());

		var items: string[] = [];

		for (var lineIdx = 0; lineIdx < lines.length; lineIdx++) {
			var lineText = lines[lineIdx];
			var foundMatch = false;

			// Loop through all available regexes
			for (var idx = 0; idx < TODO_REGEXES.length; idx++) {
				var match = lineText.match(TODO_REGEXES[idx]);
				var matchText = match && match[1]?.trim();

				// If a regex matches, return the result and stop
				if (matchText && matchText !== "") {
					items.push(matchText);
					foundMatch = true;
					break;
				}
			}

			// If the line is just "TODO", try the previous line, then try all remaining lines
			if (!foundMatch && lineText === "TODO") {
				if (lines[lineIdx - 1] !== "") {
					items.push(lines[lineIdx - 1]);
					continue;
				}

				for (
					var readahead = lineIdx + 1;
					readahead < lines.length;
					readahead++
				) {
					var readaheadText = lines[readahead];
					if (readaheadText && readaheadText !== "") {
						items.push(readaheadText);
					} else {
						break;
					}
				}
			}
		}

		if (items.length > 0) {
			console.log(file.path);
			console.log(items);
		}

		this._dict[file.path] =
			items.length > 0
				? {
						file: file,
						items: items,
				  }
				: null;
	}
}

// --------------------------------------------------------------------------------
// View
// --------------------------------------------------------------------------------
const VIEW_TYPE_ID = "todo-lister-listview";

class ToDoListTab extends ItemView {
	reader: ToDoReader;

	constructor(leaf: WorkspaceLeaf, reader: ToDoReader) {
		super(leaf);
		this.reader = reader;
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

	protected async onOpen() {
		this.reloadContents();
	}

	buildToDoItemList(app: App, container: HTMLElement, grp: IToDoGroup) {
		var div = container.createDiv();
		div.setAttribute("data-todolister-id", grp.file.path);

		// Create header as a link
		var header = div.createEl("h5");
		var link = header.createEl("a", {
			text: getBaseName(grp.file.name),
		});
		link.addEventListener("click", async () => openFile(app, grp.file));

		// Create list
		var ul = div.createEl("ul");
		grp.items.forEach((i) => ul.createEl("li", { text: i }));
	}

	async reloadContents() {
		console.log("ToDoListTab.reloadContents");

		// Clear the top-level HTML element in the view
		const container = this.containerEl;
		container.empty();

		// Search all markdown files in the vault for TODO: entries
		// Sort by filename and order in file
		var toDoItems = this.reader.getFilesInOrder();
		if (toDoItems.length > 0) {
			toDoItems.forEach((i) => {
				this.buildToDoItemList(this.app, container, i);
			});
		} else {
			container.createEl("div", {
				cls: "error-message",
				text: "No TODO items found in this vault.",
			});
		}
	}
}

async function openFile(app: App, file: TAbstractFile): Promise<void> {
	var matchingLeaf = getMatchingLeaf(app, file);
	if (matchingLeaf) {
		// If we found a matching leaf, activate it
		app.workspace.setActiveLeaf(matchingLeaf);
	} else {
		// Otherwise, create a new leaf and open the selected file
		var tFile = file as TFile;
		if (tFile) {
			var newLeaf = app.workspace.getLeaf(false);
			await newLeaf.openFile(tFile);
		}
	}
}

// --------------------------------------------------------------------------------
// Helper methods
// --------------------------------------------------------------------------------

function getBaseName(filename: string): string {
	return path.basename(filename, path.extname(filename));
}

// --------------------------------------------------------------------------------
// Plugin
// --------------------------------------------------------------------------------

export default class ToDoListerPlugin extends Plugin {
	settings: ToDoListerPluginSettings;
	reader: ToDoReader = new ToDoReader();
	view?: ToDoListTab | undefined;

	async onload() {
		await this.loadSettings();

		var app = this.app;
		this.app.workspace.onLayoutReady(async () => {
			// Read all files to initialize
			await this.reader.loadAllFiles(
				this.app,
				this.app.vault.getMarkdownFiles()
			);

			// Update the view
			if (this.view) this.view?.reloadContents();

			// Subscribe to events
			app.vault.on("create", async (f) => {
				this.reader.updateFile(app, f);
				if (this.view) this.view?.reloadContents();
			});
			app.vault.on("modify", async (f) => {
				this.reader.updateFile(app, f);
				if (this.view) this.view?.reloadContents();
			});
			app.vault.on("delete", async (f) => {
				this.reader.deleteFile(f);
				if (this.view) this.view?.reloadContents();
			});
			app.vault.on("rename", async (f, filename) => {
				this.reader.renameFile(app, f, filename);
				if (this.view) this.view?.reloadContents();
			});
		});

		// Register the TODO List view
		this.registerView(VIEW_TYPE_ID, (leaf) => {
			var newTab = new ToDoListTab(leaf, this.reader);
			this.view = newTab;
			return newTab;
		});

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
