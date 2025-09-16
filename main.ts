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
const removeMd = require("remove-markdown");

// --------------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------------
interface ToDoListerPluginSettings {}
const DEFAULT_SETTINGS: ToDoListerPluginSettings = {};

// --------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------
const TODO_LISTER_DATA_ID = "data-todolister-id";

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

	getFileFor(path: string): IToDoGroup | undefined {
		return this._dict[path] || undefined;
	}

	async loadAllFiles(app: App, files: TAbstractFile[]) {
		return await Promise.all(
			files.map(async (f) => this.loadFileFromDisk(app, f))
		);
	}

	async updateFile(app: App, file: TAbstractFile) {
		this.loadFileFromWorkspace(app, file);
	}

	deleteFile(file: TAbstractFile) {
		delete this._dict[file.path];
	}

	async renameFile(app: App, file: TAbstractFile, filename: string) {
		delete this._dict[filename];
		this.updateFile(app, file);
	}

	protected async loadFileFromDisk(app: App, file: TAbstractFile) {
		if (path.extname(file.path) !== ".md") return;

		let md = await app.vault.adapter.read(file.path);
		this.loadFile(file, md);
	}

	protected async loadFileFromWorkspace(app: App, file: TAbstractFile) {
		let leaf = getMatchingLeaf(app, file);
		if (leaf) {
			let viewContent = (leaf.view as MarkdownView).editor.getValue();
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
		let txt = removeMd(md);

		// Search for any lines where TODO: appears. Clear any formatting around it and read to the end of the line.
		let lines: string[] = txt.split(/\r?\n/).map((x: string) => x.trim());

		let items: string[] = [];

		for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
			let lineText = lines[lineIdx];
			let foundMatch = false;

			// Loop through all available regexes
			for (let idx = 0; idx < TODO_REGEXES.length; idx++) {
				let match = lineText.match(TODO_REGEXES[idx]);
				let matchText = match && match[1]?.trim();

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
					let readahead = lineIdx + 1;
					readahead < lines.length;
					readahead++
				) {
					let readaheadText = lines[readahead];
					if (readaheadText && readaheadText !== "") {
						items.push(readaheadText);
					} else {
						break;
					}
				}
			}
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

	getHtmlNodeFor(path: string) {
		return (
			this.containerEl.querySelector(
				`[${TODO_LISTER_DATA_ID}='${path}']`
			) || undefined
		);
	}

	buildNodeFor(grp: IToDoGroup) {
		let div = this.containerEl.doc.createElement("div");
		div.setAttribute(TODO_LISTER_DATA_ID, grp.file.path);

		// Create header as a link
		let header = div.createEl("h5");
		let link = header.createEl("a", {
			text: getBaseName(grp.file.name),
		});
		link.addEventListener("click", async () =>
			openFile(this.app, grp.file)
		);

		// Create list
		let ul = div.createEl("ul");
		grp.items.forEach((i) => ul.createEl("li", { text: i }));

		return div;
	}

	async updateContentsFor(path: string) {
		let node = this.getHtmlNodeFor(path);
		let data = this.reader.getFileFor(path);

		if (node && !data) {
			// Delete if there's a node, but the file data no longer exists
			this.containerEl.removeChild(node);
		} else if (!node && data) {
			// Insert if there's not a node, but there is data
			let siblingNode: HTMLElement | undefined;
			let sortedName = data.file.name;

			for (let i = 0; i < this.containerEl.childNodes.length; i++) {
				let elm = this.containerEl.childNodes[i] as HTMLElement;
				if (elm && elm.hasAttribute(TODO_LISTER_DATA_ID)) {
					let id = elm.getElementsByTagName("h5")[0]?.getText();
					if (id && id >= sortedName) {
						siblingNode = elm;
						break;
					}
				}
			}

			let newNode = this.buildNodeFor(data);
			this.containerEl.insertBefore(newNode, siblingNode || null);
		} else if (node && data) {
			// Replace if there's both a node and data
			let newNode = this.buildNodeFor(data);
			this.containerEl.replaceChild(newNode, node);
		}
	}

	async reloadContents() {
		// Clear the top-level HTML element in the view
		const container = this.containerEl;
		container.empty();

		// Search all markdown files in the vault for TODO: entries
		// Sort by filename and order in file
		let toDoItems = this.reader.getFilesInOrder();
		if (toDoItems.length > 0) {
			toDoItems.forEach((i) => {
				container.appendChild(this.buildNodeFor(i));
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
	let matchingLeaf = getMatchingLeaf(app, file);
	if (matchingLeaf) {
		// If we found a matching leaf, activate it
		app.workspace.setActiveLeaf(matchingLeaf);
	} else {
		// Otherwise, create a new leaf and open the selected file
		let tFile = file as TFile;
		if (tFile) {
			let newLeaf = app.workspace.getLeaf(false);
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

		let app = this.app;
		this.app.workspace.onLayoutReady(async () => {
			// Read all files to initialize
			await this.reader.loadAllFiles(
				this.app,
				this.app.vault.getMarkdownFiles()
			);

			// Update the view
			this.reloadView();

			// Subscribe to events
			app.vault.on("create", async (f) => {
				this.reader.updateFile(app, f);
				this.updateViewFor(f.path);
			});
			app.vault.on("modify", async (f) => {
				this.reader.updateFile(app, f);
				this.updateViewFor(f.path);
			});
			app.vault.on("delete", async (f) => {
				this.reader.deleteFile(f);
				this.updateViewFor(f.path);
			});
			app.vault.on("rename", async (f, filename) => {
				this.reader.renameFile(app, f, filename);
				this.updateViewFor(filename);
				this.updateViewFor(f.path);
			});
		});

		// Register the TODO List view
		this.registerView(VIEW_TYPE_ID, (leaf) => {
			let newTab = new ToDoListTab(leaf, this.reader);
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

	async reloadView() {
		if (this.view) this.view?.reloadContents();
	}

	async updateViewFor(path: string) {
		if (this.view) this.view?.updateContentsFor(path);
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
