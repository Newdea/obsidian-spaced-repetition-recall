import {
    ButtonComponent,
    Modal,
    App,
    MarkdownRenderer,
    Notice,
    Platform,
    TFile,
    TextAreaComponent,
    setIcon,
} from "obsidian";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import h from "vhtml";

import type SRPlugin from "src/main";
// import { Card, CardType, schedule, textInterval, ReviewResponse } from "src/scheduling";
import { Card, CardType, schedule, textInterval, ReviewResponse } from "src/scheduling";
import {
    COLLAPSE_ICON,
    MULTI_SCHEDULING_EXTRACTOR,
    LEGACY_SCHEDULING_EXTRACTOR,
    IMAGE_FORMATS,
    AUDIO_FORMATS,
    VIDEO_FORMATS,
} from "src/constants";
import { escapeRegexString, cyrb53 } from "src/utils";
import { t } from "src/lang/helpers";
import { DataLocation, algorithmNames } from "./settings";
import { RepetitionItem } from "./data";

export enum FlashcardModalMode {
    DecksList,
    Front,
    Back,
    Closed,
}

// from https://github.com/chhoumann/quickadd/blob/bce0b4cdac44b867854d6233796e3406dfd163c6/src/gui/GenericInputPrompt/GenericInputPrompt.ts#L5
export class FlashcardEditModal extends Modal {
    public plugin: SRPlugin;
    public input: string;
    public waitForClose: Promise<string>;

    private resolvePromise: (input: string) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private rejectPromise: (reason?: any) => void;
    private didSubmit = false;
    private inputComponent: TextAreaComponent;
    private readonly modalText: string;

    public static Prompt(app: App, plugin: SRPlugin, placeholder: string): Promise<string> {
        const newPromptModal = new FlashcardEditModal(app, plugin, placeholder);
        return newPromptModal.waitForClose;
    }
    constructor(app: App, plugin: SRPlugin, existingText: string) {
        super(app);
        this.plugin = plugin;
        this.titleEl.setText(t("EDIT_CARD"));
        this.titleEl.addClass("sr-centered");
        this.modalText = existingText;

        this.waitForClose = new Promise<string>((resolve, reject) => {
            this.resolvePromise = resolve;
            this.rejectPromise = reject;
        });
        this.display();
        this.open();
    }

    private display() {
        this.contentEl.empty();
        this.modalEl.addClass("sr-flashcard-input-modal");

        const mainContentContainer: HTMLDivElement = this.contentEl.createDiv();
        mainContentContainer.addClass("sr-flashcard-input-area");
        this.inputComponent = this.createInputField(mainContentContainer, this.modalText);
        this.createButtonBar(mainContentContainer);
    }

    private createButton(
        container: HTMLElement,
        text: string,
        callback: (evt: MouseEvent) => void
    ) {
        const btn = new ButtonComponent(container);
        btn.setButtonText(text).onClick(callback);
        return btn;
    }

    private createButtonBar(mainContentContainer: HTMLDivElement) {
        const buttonBarContainer: HTMLDivElement = mainContentContainer.createDiv();
        buttonBarContainer.addClass("sr-flashcard-edit-button-bar");
        this.createButton(
            buttonBarContainer,
            t("SAVE"),
            this.submitClickCallback
        ).setCta().buttonEl.style.marginRight = "0";
        this.createButton(buttonBarContainer, t("CANCEL"), this.cancelClickCallback);
    }

    protected createInputField(container: HTMLElement, value: string) {
        const textComponent = new TextAreaComponent(container);

        textComponent.inputEl.style.width = "100%";
        textComponent
            .setValue(value ?? "")
            .onChange((value) => (this.input = value))
            .inputEl.addEventListener("keydown", this.submitEnterCallback);

        return textComponent;
    }

    private submitClickCallback = (_: MouseEvent) => this.submit();
    private cancelClickCallback = (_: MouseEvent) => this.cancel();

    private submitEnterCallback = (evt: KeyboardEvent) => {
        if ((evt.ctrlKey || evt.metaKey) && evt.key === "Enter") {
            evt.preventDefault();
            this.submit();
        }
    };

    private submit() {
        this.didSubmit = true;

        this.close();
    }

    private cancel() {
        this.close();
    }

    onOpen() {
        super.onOpen();

        this.inputComponent.inputEl.focus();
    }

    onClose() {
        super.onClose();
        this.resolveInput();
        this.removeInputListener();
    }

    private resolveInput() {
        if (!this.didSubmit) this.rejectPromise(t("NO_INPUT"));
        else this.resolvePromise(this.input);
    }

    private removeInputListener() {
        this.inputComponent.inputEl.removeEventListener("keydown", this.submitEnterCallback);
    }
}

export class FlashcardModal extends Modal {
    public plugin: SRPlugin;
    public answerBtn: HTMLElement;
    public flashcardView: HTMLElement;
    public responseBtns: HTMLElement[];
    public hardBtn: HTMLElement;
    public goodBtn: HTMLElement;
    public easyBtn: HTMLElement;
    public nextBtn: HTMLElement;
    public responseDiv: HTMLElement;
    public resetButton: HTMLButtonElement;
    public editButton: HTMLElement;
    public contextView: HTMLElement;
    public currentCard: Card;
    public currentCardIdx: number;
    public currentDeck: Deck;
    public checkDeck: Deck;
    public mode: FlashcardModalMode;
    public ignoreStats: boolean;
    public cardItem: RepetitionItem;
    public options: string[];

    constructor(app: App, plugin: SRPlugin, ignoreStats = false) {
        super(app);

        this.plugin = plugin;
        this.ignoreStats = ignoreStats;
        this.options = plugin.algorithm.srsOptions();

        this.titleEl.setText(t("DECKS"));
        this.titleEl.addClass("sr-centered");

        if (Platform.isMobile) {
            this.contentEl.style.display = "block";
        }
        this.modalEl.style.position = "relative";
        this.modalEl.style.height = this.plugin.data.settings.flashcardHeightPercentage + "%";
        this.modalEl.style.width = this.plugin.data.settings.flashcardWidthPercentage + "%";

        this.contentEl.style.position = "relative";
        // this.contentEl.style.height = "92%";
        this.contentEl.addClass("sr-modal-content");

        // TODO: refactor into event handler?
        document.body.onkeydown = (e) => {
            // TODO: Please fix this. It's ugly.
            // Checks if the input textbox is in focus before processing keyboard shortcuts.
            if (
                document.activeElement.nodeName !== "TEXTAREA" &&
                this.mode !== FlashcardModalMode.DecksList
            ) {
                const consume = () => {
                    e.preventDefault();
                    e.stopPropagation();
                };
                if (this.mode !== FlashcardModalMode.Closed && e.code === "KeyS") {
                    this.skipCurrentCard();
                    consume();
                } else if (
                    this.mode === FlashcardModalMode.Front &&
                    (e.code === "Space" || e.code === "Enter")
                ) {
                    this.showAnswer();
                    consume();
                } else if (this.mode === FlashcardModalMode.Back) {
                    if (e.code === "Numpad1" || e.code === "Digit1") {
                        this.processReview(this.options[1]);
                    } else if (e.code === "Numpad2" || e.code === "Digit2" || e.code === "Space") {
                        this.processReview(this.options[2]);
                    } else if (e.code === "Numpad3" || e.code === "Digit3") {
                        this.processReview(this.options[3]);
                    } else if (e.code === "Numpad0" || e.code === "Digit0") {
                        this.processReview(this.options[0]);
                    }
                    consume();
                }
            }
        };
    }

    onOpen(): void {
        this.decksList();
    }

    onClose(): void {
        this.mode = FlashcardModalMode.Closed;
    }

    decksList(): void {
        const aimDeck = this.plugin.deckTree.subdecks.filter(
            (deck) => deck.deckName === this.plugin.data.historyDeck
        );
        if (this.plugin.data.historyDeck && aimDeck.length > 0) {
            const deck = aimDeck[0];
            this.currentDeck = deck;
            this.checkDeck = deck.parent;
            this.setupCardsView();
            deck.nextCard(this);
            return;
        }

        this.mode = FlashcardModalMode.DecksList;
        this.titleEl.setText(t("DECKS"));
        this.titleEl.innerHTML += (
            <p style="margin:0px;line-height:12px;">
                <span
                    style="background-color:#4caf50;color:#ffffff;"
                    aria-label={t("DUE_CARDS")}
                    class="tag-pane-tag-count tree-item-flair sr-deck-counts"
                >
                    {this.plugin.deckTree.dueFlashcardsCount.toString()}
                </span>
                <span
                    style="background-color:#2196f3;"
                    aria-label={t("NEW_CARDS")}
                    class="tag-pane-tag-count tree-item-flair sr-deck-counts"
                >
                    {this.plugin.deckTree.newFlashcardsCount.toString()}
                </span>
                <span
                    style="background-color:#ff7043;"
                    aria-label={t("TOTAL_CARDS")}
                    class="tag-pane-tag-count tree-item-flair sr-deck-counts"
                >
                    {this.plugin.deckTree.totalFlashcards.toString()}
                </span>
            </p>
        );
        this.contentEl.empty();
        this.contentEl.setAttribute("id", "sr-flashcard-view");

        for (const deck of this.plugin.deckTree.subdecks) {
            deck.render(this.contentEl, this);
        }
    }

    setupCardsView(): void {
        this.contentEl.empty();

        const flashCardMenu = this.contentEl.createDiv("sr-flashcard-menu");

        const backButton = flashCardMenu.createEl("button");
        backButton.addClass("sr-flashcard-menu-item");
        setIcon(backButton, "arrow-left");
        backButton.setAttribute("aria-label", t("BACK"));
        backButton.addEventListener("click", () => {
            this.plugin.data.historyDeck = "";
            this.decksList();
        });

        this.editButton = flashCardMenu.createEl("button");
        this.editButton.addClass("sr-flashcard-menu-item");
        setIcon(this.editButton, "edit");
        this.editButton.setAttribute("aria-label", t("EDIT_CARD"));
        this.editButton.addEventListener("click", async () => {
            // remove SR info from input modal prompt
            const textPromptArr = this.currentCard.cardText.split("\n");
            let textPrompt = "";
            if (textPromptArr[textPromptArr.length - 1].startsWith("<!--SR:")) {
                textPrompt = textPromptArr.slice(0, -1).join("\n");
            } else {
                textPrompt = this.currentCard.cardText;
            }

            const editModal = FlashcardEditModal.Prompt(this.app, this.plugin, textPrompt);
            editModal
                .then(async (modifiedCardText) => {
                    this.modifyCardText(textPrompt, modifiedCardText);
                })
                .catch((reason) => console.log(reason));
        });

        this.resetButton = flashCardMenu.createEl("button");
        this.resetButton.addClass("sr-flashcard-menu-item");
        setIcon(this.resetButton, "refresh-cw");
        this.resetButton.setAttribute("aria-label", t("RESET_CARD_PROGRESS"));
        this.resetButton.addEventListener("click", () => {
            this.processReview(this.options[0]);
        });
        this.responseBtns = [];
        this.responseBtns.push(this.resetButton);

        const cardInfo = flashCardMenu.createEl("button");
        cardInfo.addClass("sr-flashcard-menu-item");
        setIcon(cardInfo, "info");
        cardInfo.setAttribute("aria-label", "View Card Info");
        cardInfo.addEventListener("click", async () => {
            const currentEaseStr =
                t("CURRENT_EASE_HELP_TEXT") + (this.currentCard.ease ?? t("NEW"));
            const currentIntervalStr =
                t("CURRENT_INTERVAL_HELP_TEXT") + textInterval(this.currentCard.interval, false);
            const generatedFromStr = t("CARD_GENERATED_FROM", {
                notePath: this.currentCard.note.path,
            });
            new Notice(currentEaseStr + "\n" + currentIntervalStr + "\n" + generatedFromStr);
        });

        const skipButton = flashCardMenu.createEl("button");
        skipButton.addClass("sr-flashcard-menu-item");
        setIcon(skipButton, "chevrons-right");
        skipButton.setAttribute("aria-label", t("SKIP"));
        skipButton.addEventListener("click", () => {
            this.skipCurrentCard();
        });

        if (this.plugin.data.settings.showContextInCards) {
            this.contextView = this.contentEl.createDiv();
            this.contextView.setAttribute("id", "sr-context");
        }

        this.flashcardView = this.contentEl.createDiv("div");
        this.flashcardView.setAttribute("id", "sr-flashcard-view");

        this.responseDiv = this.contentEl.createDiv("sr-flashcard-response");

        const optBtnCounts = this.plugin.algorithm.srsOptions().length;
        let btnCols = 4;
        if (!Platform.isMobile && optBtnCounts > btnCols) {
            btnCols = optBtnCounts;
        }
        this.responseDiv.setAttribute(
            "style",
            `grid-template-columns: ${"1fr ".repeat(btnCols - 1)}`
        );

        this.options.slice(1).forEach((opt, ind) => {
            const tindex = ind + 1;
            this.responseBtns.push(document.createElement("button"));
            this.responseBtns[tindex].setAttribute(
                "id",
                "sr-" + this.options[tindex].toLowerCase() + "-btn"
            );
            this.responseBtns[tindex].setAttribute("class", "ResponseFloatBarCommandItem");
            this.responseBtns[tindex].setText(this.plugin.data.settings.flashcardHardText);
            this.responseBtns[tindex].addEventListener("click", () => {
                this.processReview(this.options[tindex]);
            });
            this.responseDiv.appendChild(this.responseBtns[tindex]);
        });
        this.hardBtn = this.responseBtns[1];
        this.easyBtn = this.responseBtns[this.responseBtns.length - 1];

        this.responseDiv.style.display = "none";

        this.answerBtn = this.contentEl.createDiv();
        this.answerBtn.setAttribute("id", "sr-show-answer");
        this.answerBtn.setText(t("SHOW_ANSWER"));
        this.answerBtn.addEventListener("click", () => {
            this.showAnswer();
        });

        if (this.ignoreStats) {
            this.options.slice(2, -1).forEach((opt, ind) => {
                this.responseBtns[ind + 2].style.display = "none";
            });
            // this.goodBtn.style.display = "none";

            this.responseDiv.addClass("sr-ignorestats-response");
            this.easyBtn.addClass("sr-ignorestats-btn");
            this.hardBtn.addClass("sr-ignorestats-btn");
        }
    }

    private async modifyCardText(originalText: string, replacementText: string) {
        if (!replacementText) return;
        if (replacementText == originalText) return;
        let fileText: string = await this.app.vault.read(this.currentCard.note);
        const originalTextRegex = new RegExp(escapeRegexString(originalText), "gm");
        fileText = fileText.replace(originalTextRegex, replacementText);
        await this.app.vault.modify(this.currentCard.note, fileText);
        this.currentDeck.deleteFlashcardAtIndex(this.currentCardIdx, this.currentCard.isDue);
        this.burySiblingCards(false);
    }

    private showAnswer(): void {
        this.mode = FlashcardModalMode.Back;

        this.answerBtn.style.display = "none";
        this.responseDiv.style.display = "grid";

        if (this.currentCard.isDue) {
            this.resetButton.disabled = false;
        }

        if (this.currentCard.cardType !== CardType.Cloze) {
            const hr: HTMLElement = document.createElement("hr");
            hr.setAttribute("id", "sr-hr-card-divide");
            this.flashcardView.appendChild(hr);
        } else {
            this.flashcardView.empty();
        }

        this.renderMarkdownWrapper(this.currentCard.back, this.flashcardView);
    }

    private async processReview(opt: string): Promise<void> {
        if (this.ignoreStats) {
            if (opt == this.options[this.options.length - 1]) {
                this.currentDeck.deleteFlashcardAtIndex(
                    this.currentCardIdx,
                    this.currentCard.isDue
                );
            }
            this.currentDeck.nextCard(this);
            return;
        }

        let interval: number, ease: number, due;
        const currSchedintvl_ease_old: number[] = [
            this.currentCard.interval,
            this.currentCard.ease,
        ];

        this.currentDeck.deleteFlashcardAtIndex(this.currentCardIdx, this.currentCard.isDue);
        const response = this.options.indexOf(opt) as ReviewResponse;
        if (opt !== this.options[0]) {
            let schedObj: Record<string, number>;
            // scheduled card
            if (this.currentCard.isDue) {
                schedObj = schedule(
                    response,
                    this.currentCard.interval,
                    this.currentCard.ease,
                    this.currentCard.delayBeforeReview,
                    this.plugin.data.settings,
                    this.plugin.dueDatesFlashcards
                );
            } else {
                let initial_ease: number = this.plugin.data.settings.baseEase;
                if (
                    Object.prototype.hasOwnProperty.call(
                        this.plugin.easeByPath,
                        this.currentCard.note.path
                    )
                ) {
                    initial_ease = Math.round(this.plugin.easeByPath[this.currentCard.note.path]);
                }

                currSchedintvl_ease_old[0] = 1;
                currSchedintvl_ease_old[1] = initial_ease;

                schedObj = schedule(
                    response,
                    1.0,
                    initial_ease,
                    0,
                    this.plugin.data.settings,
                    this.plugin.dueDatesFlashcards
                );
            }

            interval = schedObj.interval;
            ease = schedObj.ease;
            due = window.moment(Date.now() + interval * 24 * 3600 * 1000);
        } else {
            this.currentCard.interval = 1.0;
            this.currentCard.ease = this.plugin.data.settings.baseEase;
            if (this.currentCard.isDue) {
                this.currentDeck.dueFlashcards.push(this.currentCard);
            } else {
                this.currentDeck.newFlashcards.push(this.currentCard);
            }
            due = window.moment(Date.now());
            new Notice(t("CARD_PROGRESS_RESET"));
            this.currentDeck.nextCard(this);
            return;
        }

        if (this.plugin.data.settings.dataLocation === DataLocation.SaveOnNoteFile) {
            const dueString: string = due.format("YYYY-MM-DD");

            let fileText: string = await this.app.vault.read(this.currentCard.note);
            const replacementRegex = new RegExp(escapeRegexString(this.currentCard.cardText), "gm");

            let sep: string = this.plugin.data.settings.cardCommentOnSameLine ? " " : "\n";
            // Override separator if last block is a codeblock
            if (this.currentCard.cardText.endsWith("```") && sep !== "\n") {
                sep = "\n";
            }

            // check if we're adding scheduling information to the flashcard
            // for the first time
            let scheduling: (RegExpMatchArray | string[])[];
            if (this.currentCard.cardText.lastIndexOf("<!--SR:") === -1) {
                this.currentCard.cardText =
                    this.currentCard.cardText + sep + `<!--SR:!${dueString},${interval},${ease}-->`;
            } else {
                scheduling = [...this.currentCard.cardText.matchAll(MULTI_SCHEDULING_EXTRACTOR)];
                if (scheduling.length === 0) {
                    scheduling = [
                        ...this.currentCard.cardText.matchAll(LEGACY_SCHEDULING_EXTRACTOR),
                    ];
                }

                const currCardSched: string[] = [
                    "0",
                    dueString,
                    interval.toString(),
                    ease.toString(),
                ];
                if (this.currentCard.isDue) {
                    scheduling[this.currentCard.siblingIdx] = currCardSched;
                } else {
                    scheduling.push(currCardSched);
                }

                this.currentCard.cardText = this.currentCard.cardText.replace(/<!--SR:.+-->/gm, "");
                this.currentCard.cardText += "<!--SR:";
                for (let i = 0; i < scheduling.length; i++) {
                    this.currentCard.cardText += `!${scheduling[i][1]},${scheduling[i][2]},${scheduling[i][3]}`;
                }
                this.currentCard.cardText += "-->";
            }

            fileText = fileText.replace(replacementRegex, () => this.currentCard.cardText);

            await this.app.vault.modify(this.currentCard.note, fileText);
        } else {
            const store = this.plugin.store;
            const lineNo: number = this.currentCard.lineNo;
            const hash: string = cyrb53(this.currentCard.cardText);
            const cardinfo = store.getAndSyncCardInfo(this.currentCard.note, lineNo, hash);
            if (this.plugin.data.settings.algorithm === algorithmNames.Default) {
                const due = new Date();
                store.setSchedbyId(cardinfo.itemIds[this.currentCard.siblingIdx], [
                    0,
                    due.valueOf(),
                    currSchedintvl_ease_old[0],
                    currSchedintvl_ease_old[1],
                ]);
            }
            store.reviewId(cardinfo.itemIds[this.currentCard.siblingIdx], opt);
        }

        for (const sibling of this.currentCard.siblings) {
            sibling.cardText = this.currentCard.cardText;
        }
        if (this.plugin.data.settings.burySiblingCards) {
            this.burySiblingCards(true);
        }

        this.currentDeck.nextCard(this);
    }

    private async burySiblingCards(tillNextDay: boolean): Promise<void> {
        if (tillNextDay) {
            this.plugin.data.buryList.push(cyrb53(this.currentCard.cardText));
            await this.plugin.savePluginData();
        }

        for (const sibling of this.currentCard.siblings) {
            if (sibling === this.currentCard) {
                // already delete at processReview
                continue;
            }

            const dueIdx = this.currentDeck.dueFlashcards.indexOf(sibling);
            const newIdx = this.currentDeck.newFlashcards.indexOf(sibling);

            if (dueIdx !== -1) {
                this.currentDeck.deleteFlashcardAtIndex(
                    dueIdx,
                    this.currentDeck.dueFlashcards[dueIdx].isDue
                );
            } else if (newIdx !== -1) {
                this.currentDeck.deleteFlashcardAtIndex(
                    newIdx,
                    this.currentDeck.newFlashcards[newIdx].isDue
                );
            }
        }
    }

    private skipCurrentCard(): void {
        this.currentDeck.deleteFlashcardAtIndex(this.currentCardIdx, this.currentCard.isDue);
        this.burySiblingCards(false);
        this.currentDeck.nextCard(this);
    }

    // slightly modified version of the renderMarkdown function in
    // https://github.com/mgmeyers/obsidian-kanban/blob/main/src/KanbanView.tsx
    async renderMarkdownWrapper(
        markdownString: string,
        containerEl: HTMLElement,
        recursiveDepth = 0
    ): Promise<void> {
        if (recursiveDepth > 4) return;

        MarkdownRenderer.renderMarkdown(
            markdownString,
            containerEl,
            this.currentCard.note.path,
            this.plugin
        );

        containerEl.findAll(".internal-embed").forEach((el) => {
            const link = this.parseLink(el.getAttribute("src"));

            // file does not exist, display dead link
            if (!link.target) {
                el.innerText = link.text;
            } else if (link.target instanceof TFile) {
                if (link.target.extension !== "md") {
                    this.embedMediaFile(el, link.target);
                } else {
                    el.innerText = "";
                    this.renderTransclude(el, link, recursiveDepth);
                }
            }
        });
    }

    private parseLink(src: string) {
        const linkComponentsRegex =
            /^(?<file>[^#^]+)?(?:#(?!\^)(?<heading>.+)|#\^(?<blockId>.+)|#)?$/;
        const matched = typeof src === "string" && src.match(linkComponentsRegex);
        const file = matched.groups.file || this.currentCard.note.path;
        const target = this.plugin.app.metadataCache.getFirstLinkpathDest(
            file,
            this.currentCard.note.path
        );
        return {
            text: matched[0],
            file: matched.groups.file,
            heading: matched.groups.heading,
            blockId: matched.groups.blockId,
            target: target,
        };
    }

    private embedMediaFile(el: HTMLElement, target: TFile) {
        el.innerText = "";
        if (IMAGE_FORMATS.includes(target.extension)) {
            el.createEl(
                "img",
                {
                    attr: {
                        src: this.plugin.app.vault.getResourcePath(target),
                    },
                },
                (img) => {
                    if (el.hasAttribute("width"))
                        img.setAttribute("width", el.getAttribute("width"));
                    else img.setAttribute("width", "100%");
                    if (el.hasAttribute("alt")) img.setAttribute("alt", el.getAttribute("alt"));
                    el.addEventListener(
                        "click",
                        (ev) =>
                            ((ev.target as HTMLElement).style.minWidth =
                                (ev.target as HTMLElement).style.minWidth === "100%"
                                    ? null
                                    : "100%")
                    );
                }
            );
            el.addClasses(["image-embed", "is-loaded"]);
        } else if (
            AUDIO_FORMATS.includes(target.extension) ||
            VIDEO_FORMATS.includes(target.extension)
        ) {
            el.createEl(
                AUDIO_FORMATS.includes(target.extension) ? "audio" : "video",
                {
                    attr: {
                        controls: "",
                        src: this.plugin.app.vault.getResourcePath(target),
                    },
                },
                (audio) => {
                    if (el.hasAttribute("alt")) audio.setAttribute("alt", el.getAttribute("alt"));
                }
            );
            el.addClasses(["media-embed", "is-loaded"]);
        } else {
            el.innerText = target.path;
        }
    }

    private async renderTransclude(
        el: HTMLElement,
        link: {
            text: string;
            file: string;
            heading: string;
            blockId: string;
            target: TFile;
        },
        recursiveDepth: number
    ) {
        const cache = this.app.metadataCache.getCache(link.target.path);
        const text = await this.app.vault.cachedRead(link.target);
        let blockText;
        if (link.heading) {
            const clean = (s: string) => s.replace(/[\W\s]/g, "");
            const headingIndex = cache.headings?.findIndex(
                (h) => clean(h.heading) === clean(link.heading)
            );
            const heading = cache.headings[headingIndex];

            const startAt = heading.position.start.offset;
            const endAt =
                cache.headings.slice(headingIndex + 1).find((h) => h.level <= heading.level)
                    ?.position?.start?.offset || text.length;

            blockText = text.substring(startAt, endAt);
        } else if (link.blockId) {
            const block = cache.blocks[link.blockId];
            const startAt = block.position.start.offset;
            const endAt = block.position.end.offset;
            blockText = text.substring(startAt, endAt);
        } else {
            blockText = text;
        }

        this.renderMarkdownWrapper(blockText, el, recursiveDepth + 1);
    }
}

export class Deck {
    public deckName: string;
    public newFlashcards: Card[];
    public newFlashcardsCount = 0; // counts those in subdecks too
    public dueFlashcards: Card[];
    public dueFlashcardsCount = 0; // counts those in subdecks too
    public totalFlashcards = 0; // counts those in subdecks too
    public subdecks: Deck[];
    public parent: Deck | null;

    constructor(deckName: string, parent: Deck | null) {
        this.deckName = deckName;
        this.newFlashcards = [];
        this.newFlashcardsCount = 0;
        this.dueFlashcards = [];
        this.dueFlashcardsCount = 0;
        this.totalFlashcards = 0;
        this.subdecks = [];
        this.parent = parent;
    }

    createDeck(deckPath: string[]): void {
        if (deckPath.length === 0) {
            return;
        }

        const deckName: string = deckPath.shift();
        for (const deck of this.subdecks) {
            if (deckName === deck.deckName) {
                deck.createDeck(deckPath);
                return;
            }
        }

        const deck: Deck = new Deck(deckName, this);
        this.subdecks.push(deck);
        deck.createDeck(deckPath);
    }

    insertFlashcard(deckPath: string[], cardObj: Card): void {
        if (cardObj.isDue) {
            this.dueFlashcardsCount++;
        } else {
            this.newFlashcardsCount++;
        }
        this.totalFlashcards++;

        if (deckPath.length === 0) {
            if (cardObj.isDue) {
                this.dueFlashcards.push(cardObj);
            } else {
                this.newFlashcards.push(cardObj);
            }
            return;
        }

        const deckName: string = deckPath.shift();
        for (const deck of this.subdecks) {
            if (deckName === deck.deckName) {
                deck.insertFlashcard(deckPath, cardObj);
                return;
            }
        }
    }

    // count flashcards that have either been buried
    // or aren't due yet
    countFlashcard(deckPath: string[], n = 1): void {
        this.totalFlashcards += n;

        const deckName: string = deckPath.shift();
        for (const deck of this.subdecks) {
            if (deckName === deck.deckName) {
                deck.countFlashcard(deckPath, n);
                return;
            }
        }
    }

    deleteFlashcardAtIndex(index: number, cardIsDue: boolean): void {
        if (cardIsDue) {
            this.dueFlashcards.splice(index, 1);
            this.dueFlashcardsCount--;
        } else {
            this.newFlashcards.splice(index, 1);
            this.newFlashcardsCount--;
        }

        let deck: Deck = this.parent;
        while (deck !== null) {
            if (cardIsDue) {
                deck.dueFlashcardsCount--;
            } else {
                deck.newFlashcardsCount--;
            }
            deck = deck.parent;
        }
    }

    sortSubdecksList(): void {
        this.subdecks.sort((a, b) => {
            if (a.deckName < b.deckName) {
                return -1;
            } else if (a.deckName > b.deckName) {
                return 1;
            }
            return 0;
        });

        for (const deck of this.subdecks) {
            deck.sortSubdecksList();
        }
    }

    render(containerEl: HTMLElement, modal: FlashcardModal): void {
        const deckView: HTMLElement = containerEl.createDiv("tree-item");

        const deckViewSelf: HTMLElement = deckView.createDiv(
            "tree-item-self tag-pane-tag is-clickable"
        );
        const shouldBeInitiallyExpanded: boolean =
            modal.plugin.data.settings.initiallyExpandAllSubdecksInTree;
        let collapsed = !shouldBeInitiallyExpanded;
        let collapseIconEl: HTMLElement | null = null;
        if (this.subdecks.length > 0) {
            collapseIconEl = deckViewSelf.createDiv("tree-item-icon collapse-icon");
            collapseIconEl.innerHTML = COLLAPSE_ICON;
            (collapseIconEl.childNodes[0] as HTMLElement).style.transform = collapsed
                ? "rotate(-90deg)"
                : "";
        }

        const deckViewInner: HTMLElement = deckViewSelf.createDiv("tree-item-inner");
        deckViewInner.addEventListener("click", () => {
            modal.plugin.data.historyDeck = this.deckName;
            modal.currentDeck = this;
            modal.checkDeck = this.parent;
            modal.setupCardsView();
            this.nextCard(modal);
        });
        const deckViewInnerText: HTMLElement = deckViewInner.createDiv("tag-pane-tag-text");
        deckViewInnerText.innerHTML += <span class="tag-pane-tag-self">{this.deckName}</span>;
        const deckViewOuter: HTMLElement = deckViewSelf.createDiv("tree-item-flair-outer");
        deckViewOuter.innerHTML += (
            <span>
                <span
                    style="background-color:#4caf50;"
                    class="tag-pane-tag-count tree-item-flair sr-deck-counts"
                >
                    {this.dueFlashcardsCount.toString()}
                </span>
                <span
                    style="background-color:#2196f3;"
                    class="tag-pane-tag-count tree-item-flair sr-deck-counts"
                >
                    {this.newFlashcardsCount.toString()}
                </span>
                <span
                    style="background-color:#ff7043;"
                    class="tag-pane-tag-count tree-item-flair sr-deck-counts"
                >
                    {this.totalFlashcards.toString()}
                </span>
            </span>
        );

        const deckViewChildren: HTMLElement = deckView.createDiv("tree-item-children");
        deckViewChildren.style.display = collapsed ? "none" : "block";
        if (this.subdecks.length > 0) {
            collapseIconEl.addEventListener("click", () => {
                if (collapsed) {
                    (collapseIconEl.childNodes[0] as HTMLElement).style.transform = "";
                    deckViewChildren.style.display = "block";
                } else {
                    (collapseIconEl.childNodes[0] as HTMLElement).style.transform =
                        "rotate(-90deg)";
                    deckViewChildren.style.display = "none";
                }
                collapsed = !collapsed;
            });
        }
        for (const deck of this.subdecks) {
            deck.render(deckViewChildren, modal);
        }
    }

    nextCard(modal: FlashcardModal): void {
        if (this.newFlashcards.length + this.dueFlashcards.length === 0) {
            if (this.dueFlashcardsCount + this.newFlashcardsCount > 0) {
                for (const deck of this.subdecks) {
                    if (deck.dueFlashcardsCount + deck.newFlashcardsCount > 0) {
                        modal.currentDeck = deck;
                        deck.nextCard(modal);
                        return;
                    }
                }
            }

            if (this.parent == modal.checkDeck) {
                modal.plugin.data.historyDeck = "";
                modal.decksList();
            } else {
                this.parent.nextCard(modal);
            }
            return;
        }

        modal.responseDiv.style.display = "none";
        modal.resetButton.disabled = true;
        modal.titleEl.setText(
            `${this.deckName}: ${this.dueFlashcardsCount + this.newFlashcardsCount}`
        );

        modal.answerBtn.style.display = "initial";
        modal.flashcardView.empty();
        modal.mode = FlashcardModalMode.Front;

        let interval = 1.0,
            ease: number = modal.plugin.data.settings.baseEase,
            delayBeforeReview = 0;
        if (this.dueFlashcards.length > 0) {
            if (modal.plugin.data.settings.randomizeCardOrder) {
                modal.currentCardIdx = Math.floor(Math.random() * this.dueFlashcards.length);
            } else {
                modal.currentCardIdx = 0;
            }
            modal.currentCard = this.dueFlashcards[modal.currentCardIdx];
            modal.renderMarkdownWrapper(modal.currentCard.front, modal.flashcardView);

            interval = modal.currentCard.interval;
            ease = modal.currentCard.ease;
            delayBeforeReview = modal.currentCard.delayBeforeReview;
        } else if (this.newFlashcards.length > 0) {
            if (modal.plugin.data.settings.randomizeCardOrder) {
                const pickedCardIdx = Math.floor(Math.random() * this.newFlashcards.length);
                modal.currentCardIdx = pickedCardIdx;

                // look for first unscheduled sibling
                const pickedCard: Card = this.newFlashcards[pickedCardIdx];
                let idx = pickedCardIdx;
                while (idx >= 0 && pickedCard.siblings.includes(this.newFlashcards[idx])) {
                    if (!this.newFlashcards[idx].isDue) {
                        modal.currentCardIdx = idx;
                    }
                    idx--;
                }
            } else {
                modal.currentCardIdx = 0;
            }

            modal.currentCard = this.newFlashcards[modal.currentCardIdx];
            modal.renderMarkdownWrapper(modal.currentCard.front, modal.flashcardView);

            if (
                Object.prototype.hasOwnProperty.call(
                    modal.plugin.easeByPath,
                    modal.currentCard.note.path
                )
            ) {
                ease = modal.plugin.easeByPath[modal.currentCard.note.path];
            }
        }

        const store = modal.plugin.store;
        const lineNo: number = modal.currentCard.lineNo;
        const hash: string = cyrb53(modal.currentCard.cardText);
        const cardinfo = store.getAndSyncCardInfo(modal.currentCard.note, lineNo, hash);

        const cardId = cardinfo.itemIds[modal.currentCard.siblingIdx];
        const cardItem = store.getItembyID(cardId);
        const intervals = modal.plugin.algorithm.calcAllOptsIntervals(cardItem);
        const algo = modal.plugin.data.settings.algorithm;
        const btnTexts = modal.plugin.data.settings.responseOptionBtnsText[algo];
        if (modal.ignoreStats) {
            // Same for mobile/desktop
            modal.hardBtn.setText(`${btnTexts[1]}`);
            modal.easyBtn.setText(`${btnTexts[btnTexts.length - 1]}`);
        } else if (!modal.plugin.data.settings.intervalShowHide) {
            for (let i = 1; i < modal.responseBtns.length; i++) {
                modal.responseBtns[i].setText(`${btnTexts[i]}`);
            }
        } else if (Platform.isMobile) {
            for (let i = 1; i < modal.responseBtns.length; i++) {
                modal.responseBtns[i].setText(
                    textInterval(Math.round(intervals[i] * 100) / 100, true)
                );
            }
            // modal.hardBtn.setText(textInterval(hardInterval, true));
            // modal.goodBtn.setText(textInterval(goodInterval, true));
            // modal.easyBtn.setText(textInterval(easyInterval, true));
        } else {
            for (let i = 1; i < modal.responseBtns.length; i++) {
                modal.responseBtns[i].setText(
                    `${btnTexts[i]} - ${textInterval(Math.round(intervals[i] * 100) / 100, false)}`
                );
            }
            /* modal.hardBtn.setText(
                `${modal.plugin.data.settings.flashcardHardText} - ${textInterval(
                    hardInterval,
                    false
                )}`
            );
            modal.goodBtn.setText(
                `${modal.plugin.data.settings.flashcardGoodText} - ${textInterval(
                    goodInterval,
                    false
                )}`
            );
            modal.easyBtn.setText(
                `${modal.plugin.data.settings.flashcardEasyText} - ${textInterval(
                    easyInterval,
                    false
                )}`
            ); */
        }

        if (modal.plugin.data.settings.showContextInCards)
            modal.contextView.setText(modal.currentCard.context);
    }
}