import { QuestManager } from '../quest-manager.js';
import { QuestSheet } from './quest-sheet.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class QuestLogApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options={}) {
    super(options);
    this.currentFilter = 'active';
  }
  static DEFAULT_OPTIONS = {
    tag: 'form',
    id: 'phils-quest-log',
    classes: ['pqt-app', 'pqt-quest-log'],
    window: {
      title: 'PQT.AppName',
      icon: 'fas fa-scroll',
      resizable: true,
      controls: []
    },
    position: {
      width: 800,
      height: 600
    },
    actions: {
      createQuest: QuestLogApp.createQuest,
      openQuest: QuestLogApp.openQuest,
      deleteQuest: QuestLogApp.deleteQuest,
      setFilter: QuestLogApp.setFilter,
      copyUuid: QuestLogApp.copyUuid
    }
  };

  static PARTS = {
    main: {
      template: 'modules/phils-quest-tracker/templates/quest-log.hbs',
      scrollable: ['.pqt-quest-list']
    }
  };

  async _prepareContext(options) {
    let quests = QuestManager.getQuests();
    
    // Filter by Status first (unless specific override?)
    // Default to 'active'
    const filter = this.currentFilter;
    
    // Sort by Sort Value
    quests.sort((a, b) => {
        const da = a.getFlag('phils-quest-tracker', 'data') || {};
        const db = b.getFlag('phils-quest-tracker', 'data') || {};
        return (da.sort || 0) - (db.sort || 0);
    });

    quests = quests.filter(q => {
        const data = q.getFlag('phils-quest-tracker', 'data');
        if (data.status !== filter) return false;
        
        // Permission Check (Non-GM)
        if (!game.user.isGM) {
             // Explicitly hide GM Only quests regardless of permissions (e.g. Authors)
             if (data.visibility === 'gm') return false;
             
             if (!data.visibleTo || data.visibleTo.length === 0) return true;
             return data.visibleTo.includes(game.user.id);
        }
        return true;
    });

    // Enrich quests and Group
    const groups = {
      main: { label: "PQT.Category.Main", quests: [] },
      side: { label: "PQT.Category.Side", quests: [] },
      personal: { label: "PQT.Category.Personal", quests: [] },
      // Fallback for old data?
      misc: { label: "Misc", quests: [] }
    };

    for (const q of quests) {
      const data = q.getFlag('phils-quest-tracker', 'data');
      const enriched = {
        id: q.id,
        uuid: q.uuid,
        ...data,
        isCompleted: data.status === 'completed',
        isFailed: data.status === 'failed',
        isActive: data.status === 'active',
        isGM: game.user.isGM
      };
      
      const cat = data.category || 'misc'; // Default to misc if undefined
      if (groups[cat]) groups[cat].quests.push(enriched);
      else groups.misc.quests.push(enriched);
    }
    
    // Convert to array for easy iteration, filtering out empty groups
    const sections = Object.values(groups).filter(g => g.quests.length > 0);

    return {
      sections,
      hasQuests: sections.length > 0,
      isGM: game.user.isGM,
      filters: [
        { id: 'active', label: "PQT.Status.Active", css: filter === 'active' ? 'active' : '' },
        { id: 'completed', label: "PQT.Status.Completed", css: filter === 'completed' ? 'active' : '' },
        { id: 'failed', label: "PQT.Status.Failed", css: filter === 'failed' ? 'active' : '' },
        { id: 'available', label: "PQT.Status.Available", css: filter === 'available' ? 'active' : '' },
        { id: 'draft', label: "PQT.Status.Draft", css: filter === 'draft' ? 'active' : '' }
      ]
    };
  }

  /* ------------------------------------------- */
  /*  Actions                                    */
  /* ------------------------------------------- */

  static async createQuest(event, target) {
    const quest = await QuestManager.createQuest();
    
    // Switch to Draft tab
    this.currentFilter = 'draft';
    
    // Render Log
    this.render();
    
    // Open Quest Sheet immediately
    // Handled by Hook in main.js to avoid double-opening

  }


  static async openQuest(event, target) {
    const questId = target.dataset.questId;
    const quest = game.journal.get(questId);
    if (quest) {

       new QuestSheet(quest).render(true);
    }
  }

  static renderSidebarControl(app, html) {
    if (html instanceof HTMLElement) html = $(html);
    
    const headerActions = html.find('.header-actions');
    if (headerActions.length === 0) return; // Not found (maybe popout)

    // Check if duplicate
    if (headerActions.find('.quest-log-btn').length > 0) return;

    const btn = $(`<button class="quest-log-btn"><i class="fas fa-scroll"></i> ${game.i18n.localize("PQT.AppName")}</button>`);
    

    
    btn.on('click', () => {
      new QuestLogApp().render(true);
    });

    headerActions.prepend(btn); // Or append? Prepend makes it visible first.
  }


  static async copyUuid(event, target) {
    event.stopPropagation();
    const uuid = target.dataset.questUuid;
    await navigator.clipboard.writeText(uuid);
    ui.notifications.info(game.i18n.localize('PQT.Message.UUIDCopied'));
  }

  static async deleteQuest(event, target) {
    const questId = target.dataset.questId;
    // Confirm dialog V2
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize('PQT.Action.Delete') },
      content: game.i18n.localize('PQT.Message.ConfirmDelete'),
      modal: true
    });
    
    if (confirmed) {
      await game.journal.get(questId)?.delete();
      this.render();
    }
  }

  static async setFilter(event, target) {
      const filter = target.dataset.filter;
      if (filter) {
          this.currentFilter = filter;
          this.render();
      }
  }

  /* ------------------------------------------- */
  /*  Quest Drag & Drop                          */
  /* ------------------------------------------- */
  
  _attachPartListeners(partId, htmlElement, options) {
      super._attachPartListeners(partId, htmlElement, options);
      
      if (partId === 'main') {
          const cards = htmlElement.querySelectorAll('.pqt-quest-card');
          for (const card of cards) {
              card.addEventListener('dragstart', this._onDragStartQuest.bind(this));
              card.addEventListener('dragover', this._onDragOverQuest.bind(this));
              card.addEventListener('drop', this._onDropQuest.bind(this));
          }
      }
  }

  _onDragStartQuest(event) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", JSON.stringify({
          type: "Quest",
          uuid: event.currentTarget.dataset.questId
      }));
  }

  _onDragOverQuest(event) {
      event.preventDefault();
      // Only allow if dragging Quest
      event.dataTransfer.dropEffect = "move";
  }

  async _onDropQuest(event) {
      event.preventDefault();
      event.stopPropagation();
      
      const dataStr = event.dataTransfer.getData("text/plain");
      if (!dataStr) return;
      
      try {
          const data = JSON.parse(dataStr);
          if (data.type !== "Quest") return;
          
          const draggedId = data.uuid;
          const targetCard = event.currentTarget.closest('.pqt-quest-card');
          if (!targetCard) return;
          
          const targetId = targetCard.dataset.questId;
          if (draggedId === targetId) return;


          const container = targetCard.closest('.pqt-section-group');
          if (!container) return;
          
          const cardNodes = Array.from(container.querySelectorAll('.pqt-quest-card'));
          const ids = cardNodes.map(c => c.dataset.questId);
          
          const fromIndex = ids.indexOf(draggedId);
          const toIndex = ids.indexOf(targetId);
          
          if (fromIndex === -1 || toIndex === -1) return; // Should not happen
          
          // Reorder array
          ids.splice(fromIndex, 1);
          ids.splice(toIndex, 0, draggedId);
          

          const updates = ids.map((id, index) => {
              // We need to find the Journal Entry
              const entry = game.journal.get(id);
              if (!entry) return null;
              
              const currentData = entry.getFlag(QuestManager.ID, QuestManager.FLAG) || {};

              return { 
                  _id: id, 
                  [`flags.${QuestManager.ID}.${QuestManager.FLAG}.sort`]: index * 10 
              };
          }).filter(u => u);

          // JournalEntry.updateDocuments(updates)

          await JournalEntry.updateDocuments(updates);
          
          // Render App
          this.render();

      } catch (e) {
          console.error("PQT | Quest Drop Error", e);
      }
  }
}
