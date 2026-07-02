import { QuestManager } from '../quest-manager.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class QuestSheet extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(journalEntry, options = {}) {
    super(options);
    this.document = journalEntry;

    this._onDeleteBound = this._onDelete.bind(this);
    this._onUpdateBound = this._onUpdate.bind(this);
    Hooks.on("deleteJournalEntry", this._onDeleteBound);
    Hooks.on("updateJournalEntry", this._onUpdateBound);

    this.tabGroups = { primary: "overview" };

    this.editingMode = {
        description: false,
        gm: false,
        player: false
    };
  }

  /* ------------------------------------------- */
  /*  Life Cycle                                 */
  /* ------------------------------------------- */

  _onRender(context, options) {
      super._onRender(context, options);
      
      const accessSelect = this.element.querySelector('.pqt-access-select');
      if (accessSelect) {
          accessSelect.addEventListener('change', async (event) => {
              const newLevel = Number(event.target.value);
              const currentLevel = this.document.ownership.default ?? 0;
              
              const updates = { "ownership.default": newLevel };
              
              if (newLevel === 0) {
                  updates[`flags.${QuestManager.ID}.${QuestManager.FLAG}.visibility`] = "gm";
              } else {
                  updates[`flags.${QuestManager.ID}.${QuestManager.FLAG}.visibility`] = "always";
              }

              if (newLevel !== currentLevel) {
                  await this.document.update(updates);
              }
          });
      }
  }

  async close(options = {}) {
      Hooks.off("deleteJournalEntry", this._onDeleteBound);
      Hooks.off("updateJournalEntry", this._onUpdateBound);
      return super.close(options);
  }

  _onDelete(document, options, userId) {
      if (document.uuid === this.document.uuid) {
          this.close();
      }
  }

  _onUpdate(document, changes, options, userId) {
      if (document.uuid === this.document.uuid) {
          this.render();
      }
  }

  static DEFAULT_OPTIONS = {
    tag: 'form',
    classes: ['pqt-app', 'pqt-quest-sheet'],
    window: {
      title: 'PQT.Title',
      icon: 'fas fa-book-open',
      resizable: true,
      controls: []
    },
    position: {
      width: 600,
      height: 850
    },
    actions: {
      saveQuest: this.prototype.saveQuest,
      deleteObjective: this.prototype.deleteObjective,
      addObjective: this.prototype.addObjective,
      deleteReward: this.prototype.deleteReward,
      deleteQuest: this.prototype.deleteQuest,
      exportQuest: this.prototype.exportQuest,
      pickDate: this.prototype.pickDate,
      deleteGiver: this.prototype.deleteGiver,
      toggleRewardVisibility: this.prototype.toggleRewardVisibility,
      saveAndClose: this.prototype.saveAndClose,
      changeTab: this.prototype.changeTab,
      toggleEditor: this.prototype.toggleEditor
    },
    form: {
      handler: this.prototype.formHandler,
      submitOnChange: true,
      closeOnSubmit: false
    },
    dragDrop: [{ dragSelector: null, dropSelector: ".pqt-drop-zone" }] // V2 specific drag drop?
  };

  static PARTS = {
    main: {
      template: 'modules/phils-quest-tracker/templates/quest-sheet.hbs',
      scrollable: ['.pqt-scrollable']
    }
  };

  get title() {
    return this.document?.name || "Quest";
  }

  async _prepareContext(options) {
    if (this.document.uuid) {
        const freshDoc = await fromUuid(this.document.uuid);
        if (freshDoc) this.document = freshDoc;
    }
    
    const data = this.document.getFlag(QuestManager.ID, QuestManager.FLAG) || QuestManager.defaultQuestData;
    
    // Enrich HTML description
    const editorCls = foundry.applications?.ux?.TextEditor || TextEditor;
    const description = await editorCls.enrichHTML(data.description, {
      secrets: this.document.isOwner,
      async: true
    });
    
    const gmNotesEnriched = await editorCls.enrichHTML(data.notes?.gm || "", {
      secrets: this.document.isOwner,
      async: true
    });

    const playerNotesEnriched = await editorCls.enrichHTML(data.notes?.player || "", {
      secrets: this.document.isOwner, // Or check Observer?
      async: true
    });

    // Migration: Source -> Givers
    if (data.source && data.source.uuid && (!data.givers || data.givers.length === 0)) {
        data.givers = [data.source];
    }
    if (!data.givers) data.givers = [];

    return {
      quest: data,
      document: this.document,
      description: description,
      gmNotesEnriched: gmNotesEnriched,
      playerNotesEnriched: playerNotesEnriched,
      editingMode: this.editingMode,
      isGM: game.user.isGM,
      isEditing: this.document.isOwner,
      hasRevealedRewards: data.rewards?.some(r => r.revealed) || false,
      statuses: {
        active: "PQT.Status.Active",
        completed: "PQT.Status.Completed",
        failed: "PQT.Status.Failed",
        available: "PQT.Status.Available",
        draft: "PQT.Status.Draft"
      },
      visibilities: {
        always: "PQT.Visibility.Always",
        gm: "PQT.Visibility.GM",
        date: "PQT.Visibility.Date"
      },
      categories: {
        main: "PQT.Category.Main",
        side: "PQT.Category.Side",
        personal: "PQT.Category.Personal"
      },
      accessLevels: {
          "2": "PQT.Access.Observer",
          "3": "PQT.Access.Owner"
      },
      currentAccess: String(this.document.ownership.default === 0 ? 2 : (this.document.ownership.default ?? 0)),
      gmNotes: data.notes?.gm || "",
      playerNotes: data.notes?.player || "",
      activeTab: this.tabGroups.primary
    };
  }

  async toggleEditor(event, target) {
      const field = target.dataset.field; // "description", "gm", "player"
      if (!field) return;

      const isEditing = this.editingMode[field];
      
      if (isEditing) {
          // We are turning it OFF. Save first.
          await this.submit();
      }
      
      this.editingMode[field] = !isEditing;
      this.render();
  }



  async pickDate(event, target) {
      if (!window.PhilsDayNightCycle) return ui.notifications.warn("Phils Day Night Cycle not active.");
      
      const app = new window.PhilsDayNightCycle.PhilsCalendarApp({
          onDateSelect: (dateKey) => {
              const [y, m, d] = dateKey.split('-').map(Number);
              const formatted = `${String(d).padStart(2, '0')}. ${String(m+1).padStart(2, '0')}. ${y}`;
              
              const input = target.closest('.date-field').querySelector('input');
              if (input) {
                  input.value = formatted;
                  // Trigger change for submitOnChange
                  input.dispatchEvent(new Event('change', { bubbles: true }));
              }
          }
      });
      app.render(true);
  }

  async changeTab(event, target) {
      await this.submit(); // Save pending changes (including ProseMirror)
      
      const tab = target.dataset.tab;
      const group = target.dataset.group;
      if (tab && group) {
          this.tabGroups[group] = tab;
          this.render();
      }
  }



  async saveQuest(event, target) {
    await this.submit();
  }

  async saveAndClose(event, target) {
    await this.submit();
    this.close();
  }

  async deleteQuest(event, target) {
      const confirm = await foundry.applications.api.DialogV2.confirm({
          window: { title: game.i18n.localize("PQT.Title.DeleteQuest") || "Delete Quest" },
          content: `<p>${game.i18n.localize("PQT.Message.DeleteQuestConfirm") || "Are you sure you want to delete this quest?"}</p>`,
          modal: true
      });

      if (confirm) {
          await this.document.delete();
          // Auto-close hook handles closing
      }
  }



  async addObjective(event, target) {
    const FormDataExt = foundry.applications?.ux?.FormDataExtended || FormDataExtended;
    await this.submit();
    
    // Add objective to flag
    const data = this.document.getFlag(QuestManager.ID, QuestManager.FLAG) || {};
    let objectives = data.objectives;
    
    // Safeguard: Ensure objectives is an array
    if (!Array.isArray(objectives)) {
        objectives = objectives ? Object.values(objectives) : [];
    }


    objectives.push({ id: foundry.utils.randomID(), text: "", completed: false });
    
    await this.document.setFlag(QuestManager.ID, QuestManager.FLAG, { objectives });
    await this._renderAndPreserveScroll();
  }

  async deleteObjective(event, target) {
    if (this instanceof QuestSheet) await this.submit(); 
    const id = target.dataset.id;
    const data = this.document.getFlag(QuestManager.ID, QuestManager.FLAG);
    const objectives = data.objectives.filter(o => o.id !== id);
    await this.document.setFlag(QuestManager.ID, QuestManager.FLAG, { objectives });
    await this._renderAndPreserveScroll();
  }

  async deleteGiver(event, target) {
      if (this instanceof QuestSheet) await this.submit();
      const index = Number(target.dataset.index);
      const data = this.document.getFlag(QuestManager.ID, QuestManager.FLAG);
      let givers = data.givers || [];
      if (!Array.isArray(givers)) givers = Object.values(givers);

      if (givers && givers[index]) {
          givers.splice(index, 1);
          await this.document.setFlag(QuestManager.ID, QuestManager.FLAG, { givers: givers });
          await this.document.setFlag(QuestManager.ID, QuestManager.FLAG, { givers: givers });
          await this._renderAndPreserveScroll();
      }
      }

  async deleteReward(event, target) {
      if (this instanceof QuestSheet) await this.submit();
      const index = Number(target.dataset.index);
      const data = this.document.getFlag(QuestManager.ID, QuestManager.FLAG);
      let rewards = data.rewards || [];
      if (!Array.isArray(rewards)) rewards = Object.values(rewards);

      if (rewards && rewards[index]) {
          rewards.splice(index, 1);
          await this.document.setFlag(QuestManager.ID, QuestManager.FLAG, { rewards: rewards });
          await this._renderAndPreserveScroll();
      }
  }

  async toggleRewardVisibility(event, target) {
      if (this instanceof QuestSheet) await this.submit(); // Ensure context is correct instance
      const index = Number(target.dataset.index);
      
      const data = this.document.getFlag(QuestManager.ID, QuestManager.FLAG);
      let rewards = data.rewards || [];
      if (!Array.isArray(rewards)) rewards = Object.values(rewards);

      if (rewards && rewards[index]) {
          // Toggle boolean
          rewards[index].revealed = !rewards[index].revealed;
          
          await this.document.setFlag(QuestManager.ID, QuestManager.FLAG, { rewards: rewards });
          await this._renderAndPreserveScroll();
      }
  }



  async _renderAndPreserveScroll() {
      const scrollContainer = this.element.querySelector('.pqt-content');
      const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
      
      await this.render();
      
      const newContainer = this.element.querySelector('.pqt-content');
      if (newContainer) {
          newContainer.scrollTop = scrollTop;
      }
  }
  
  async exportQuest(event, target) {
    // Export to Markdown
    const data = this.document.getFlag(QuestManager.ID, QuestManager.FLAG);
    const content = `# ${data.title}\n\n${data.description}\n\n## Objectives\n${data.objectives.map(o => `- [${o.completed ? 'x' : ' '}] ${o.text}`).join('\n')}`;
    
    saveDataToFile(content, "text/markdown", `${data.title}.md`);
  }


  
  async formHandler(event, form, formData) {
    const data = formData.object;
    // Process form data back into structure
    // We need to map "objectives.0.text" -> array
    const expanded = foundry.utils.expandObject(data);
    
    if (expanded.objectives && !Array.isArray(expanded.objectives)) {
        expanded.objectives = Object.values(expanded.objectives);
    }

    if (expanded.rewards && !Array.isArray(expanded.rewards)) {
        expanded.rewards = Object.values(expanded.rewards);
    }

    if (expanded.givers && !Array.isArray(expanded.givers)) {
        expanded.givers = Object.values(expanded.givers);
    }
    
    // Update Flags
    
    const updateData = {};
    
    // Merge with existing to keep other fields
    const current = this.document.getFlag(QuestManager.ID, QuestManager.FLAG) || {};
    
    // Auto-setup for Date Visibility
    if (expanded.visibility === 'date' && current.visibility !== 'date') {
        expanded.syncWithCalendar = true;
        
        if (expanded.status === 'active') {
             expanded.status = 'available';
        }
    }

    // Handle Notes (Nested) - Ensure structure exists
    if (expanded.notes) {
        if (!current.notes) current.notes = {};
    }
    
    // Check if user has permission to update the document (Flags)
    if (!this.document.isOwner) {
        // ... (Observer Logic) ...
        // Only act if the notes editor was actually open (field present in the form).
        // Otherwise a tab change would submit an empty value and wipe the notes.
        if (expanded.notes?.player === undefined) return;

        const currentNotes = current.notes?.player || "";
        const newNotes = expanded.notes.player || "";

        if (newNotes !== currentNotes) {
             console.log(`PQT | Player Note Change Detected for ${this.document.name}`, {old: currentNotes, new: newNotes});

             const gmUser = game.users.find(u => u.isGM && u.active);
             if (!gmUser) {
                 ui.notifications.warn("Cannot save Player Notes: No GM is currently connected.");
                 console.warn("PQT | Cannot save Player Notes via Socket: No GM connected.");
                 return;
             }

             game.socket.emit('module.phils-quest-tracker', {
                 type: 'updateQuestFlags',
                 questId: this.document.id,
                 updateData: { "notes.player": newNotes },
                 userId: game.user.id
             });
             ui.notifications.info(game.i18n.localize("PQT.Message.NotesSaved"));
        } else {
             console.log("PQT | Player Notes unchanged or empty update.");
        }
        return;
    }
    
    // Prepare Flag Update
    // Calculate the difference between current flags and form data
    const changes = foundry.utils.diffObject(current, expanded);
    
    // Only update if there are actual changes
    if (!foundry.utils.isEmpty(changes)) {
         console.log("PQT | Updating Flags:", changes);
         await this.document.update({
             [`flags.${QuestManager.ID}.${QuestManager.FLAG}`]: changes
         });
         
         // Sync Title/Name if changed
         if (changes.title && changes.title !== this.document.name) {
             await this.document.update({ name: changes.title });
         }
    } else {
        console.log("PQT | No flag changes detected. Skipping flag update.");
    }
  }


  
  _onDragOver(event) {
    // Standard HTML5 dragover
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  async _onDrop(event) {
    await this.submit(); // Save form state before processing drop
    const editorCls = foundry.applications?.ux?.TextEditor || TextEditor;
    const data = editorCls.getDragEventData(event);
    if (!data) return;

    if (data.type === "Actor") {
      const actor = await fromUuid(data.uuid);
      if (actor) {
        // Add Giver (Append)
        const current = this.document.getFlag(QuestManager.ID, QuestManager.FLAG) || {};
        let givers = current.givers || [];
        
        // Safety: Ensure it's an array if corrupted
        if (!Array.isArray(givers)) givers = Object.values(givers);
        
        // Prevent Duplicates
        if (!givers.some(g => g.uuid === data.uuid)) {
            givers.push({
                uuid: data.uuid,
                name: actor.name,
                img: actor.img
            });
            await this.document.setFlag(QuestManager.ID, QuestManager.FLAG, { givers });
            await this._renderAndPreserveScroll();
        }
      }
    } else if (data.type === "Item") {
      const item = await fromUuid(data.uuid);
      if (item) {
         // Add Reward
         const current = this.document.getFlag(QuestManager.ID, QuestManager.FLAG);
         const rewards = current.rewards || [];
         rewards.push({
           type: 'item',
           uuid: data.uuid,
           name: item.name,
           img: item.img,
           quantity: 1
         });
         await this.document.setFlag(QuestManager.ID, QuestManager.FLAG, { rewards });
         await this._renderAndPreserveScroll();
      }
    }
  }

  /** @override */
  _attachPartListeners(partId, htmlElement, options) {
    super._attachPartListeners(partId, htmlElement, options);
    htmlElement.addEventListener("dragover", this._onDragOver.bind(this));
    htmlElement.addEventListener("drop", this._onDrop.bind(this));

    // Visibility Change Listener
    const visibilitySelect = htmlElement.querySelector('select[name="visibility"]');
    if (visibilitySelect) {
        visibilitySelect.addEventListener('change', (event) => {
            if (event.target.value === 'date') {
                // 1. Auto-Check Sync with Calendar
                const syncCheckbox = htmlElement.querySelector('input[name="syncWithCalendar"]');
                if (syncCheckbox && !syncCheckbox.checked) {
                    syncCheckbox.checked = true;
                    syncCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
                }

                // 2. Auto-Set Status to Available
                const statusSelect = htmlElement.querySelector('select[name="status"]');
                if (statusSelect && (statusSelect.value === 'active' || statusSelect.value === 'draft')) {
                    statusSelect.value = 'available';
                    statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        });
    }

    // Drag & Drop for Objectives
    const objList = htmlElement.querySelectorAll('.objective-item');
    for (const li of objList) {
        li.addEventListener('dragstart', this._onDragStartObjective.bind(this));
        li.addEventListener('dragover', this._onDragOverObjective.bind(this));
        li.addEventListener('dragleave', this._onDragLeaveObjective.bind(this));
        li.addEventListener('drop', this._onDropObjective.bind(this));
    }
  }



  _onDragStartObjective(event) {
      // Allow drag only if handle or LI is target
      if (event.target.tagName === "INPUT" || event.target.tagName === "BUTTON") {
         return; 
      }
      
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", JSON.stringify({
          type: "Objective",
          index: Number(event.currentTarget.dataset.index)
      }));
      console.log("PQT | Drag Start Objective", event.currentTarget.dataset.index);
  }

  _onDragOverObjective(event) {
      const li = event.currentTarget;
      event.preventDefault();
      event.stopPropagation();
      
      event.dataTransfer.dropEffect = "move";
      
      li.classList.add('drag-over');
  }
  
  _onDragLeaveObjective(event) {
      const li = event.currentTarget;
      li.classList.remove('drag-over');
  }

  async _onDropObjective(event) {
      event.preventDefault();
      event.stopPropagation();
      
      const li = event.currentTarget;
      li.classList.remove('drag-over');

      const dataStr = event.dataTransfer.getData("text/plain");
      if (!dataStr) {
          console.warn("PQT | No data in drop");
          return;
      }
      
      try {
          const data = JSON.parse(dataStr);
          if (data.type !== "Objective") return;

          const fromIndex = data.index;
          const toIndex = Number(li.dataset.index);

          console.log(`PQT | Dropping Objective ${fromIndex} -> ${toIndex}`);

          if (fromIndex === toIndex) return;

          await this.submit();

          const flagData = this.document.getFlag(QuestManager.ID, QuestManager.FLAG) || {};
          let objectives = flagData.objectives || [];
          // Ensure array
          if (!Array.isArray(objectives)) objectives = Object.values(objectives);

          // Validation
          if (fromIndex < 0 || fromIndex >= objectives.length) return;

          // Move
          const item = objectives.splice(fromIndex, 1)[0];
          objectives.splice(toIndex, 0, item);

          await this.document.setFlag(QuestManager.ID, QuestManager.FLAG, { objectives });
          await this._renderAndPreserveScroll();

      } catch (e) {
          console.error("PQT | Drop Error", e);
      }
  }
}
