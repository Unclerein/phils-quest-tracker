export class QuestManager {
  static ID = 'phils-quest-tracker';
  static FLAG = 'data';
  static FOLDER_NAME = 'Phils Quest Tracker';
  static pendingCreation = false;

  /**
   * Initialize module (called in 'init' hook)
   */
  static init() {
    // Register hook to hide folder
    // Register hook to hide folder
    Hooks.on('renderJournalDirectory', (app, html, data) => this._hideQuestFolder(app, html));
    
    // Initialize Hooks
    this.initHooks();
  }

  static initHooks() {
      Hooks.on('ready', () => this.checkVisibility());
      Hooks.on('updateWorldTime', () => this.checkVisibility());
      
      // Create / Update
      Hooks.on('updateJournalEntry', async (doc, change, options, userId) => {
          // Check if it's ours
          if (!doc.getFlag(this.ID, this.FLAG)) return;
          
          const data = doc.getFlag(this.ID, this.FLAG);

          // Re-check permissions and Sync
          if (change.flags?.[this.ID]?.[this.FLAG] || change.ownership) {
              await this.updateQuestPermissions(doc, data);
          }
            
          if (data.syncWithCalendar) {
               await this.addToCalendar(data, doc.id);
          }

          // Check for Status Change -> Completed
          // We check 'change' to see if status was just updated to 'completed'
          const changedData = change.flags?.[this.ID]?.[this.FLAG];
          if (changedData && changedData.status === 'completed') {
               // Verify it wasn't already completed? 
               // logic: The hook fires on change. If status is in change, it changed.
               // But to be safe against "update to completed again", we could check old data?
               // Actually in 'updateJournalEntry', 'doc' is the updated document. 
               // But we only care if 'change' contains the status switch.

               await this.handleQuestCompletion(doc, data);
          }
      });

      // Pre-Update (Cleanup Old Events if disabling sync or changing date)
      Hooks.on('preUpdateJournalEntry', async (doc, change, options, userId) => {
          const flag = doc.getFlag(this.ID, this.FLAG);
          if (!flag || (flag.type && flag.type !== 'quest')) return;

          // Detect meaningful changes
          const expandedChange = foundry.utils.expandObject(change);
          const newFlag = expandedChange.flags?.[this.ID]?.[this.FLAG] || {};
          
          const titleChanged = newFlag.title && newFlag.title !== flag.title;
          const dateChanged = newFlag.dates?.start && newFlag.dates.start !== flag.dates.start;
          const syncChanged = newFlag.syncWithCalendar !== undefined && newFlag.syncWithCalendar !== flag.syncWithCalendar;

          // If Sync was ON, and we are changing something relevant, OR turning sync OFF
          if (flag.syncWithCalendar && (titleChanged || dateChanged || (syncChanged && newFlag.syncWithCalendar === false))) {
              await this.removeFromCalendar(doc.id, flag);
          }
      });

      // Delete
      Hooks.on('deleteJournalEntry', async (doc, options, userId) => {
          const data = doc.getFlag(this.ID, this.FLAG);
          // If we have data, we try to clean up.
          if (data) { 
               await this.removeFromCalendar(String(doc.id), data);
          }
      });
  }

  /**
   * Hide the Quest Tracker folder from the Journal Directory sidebar
   */
  static _hideQuestFolder(app, html) {
    if (!game.user.isGM) return; 
    
    if (html instanceof HTMLElement) html = $(html);

    const folderName = this.FOLDER_NAME;
    const folder = game.folders.find(f => f.name === folderName && f.type === 'JournalEntry');
    if (!folder) return;

    // Remove from UI
    const folderElement = html.find(`.folder[data-folder-id="${folder.id}"]`);
    if (folderElement) folderElement.remove();
  }

  /**
   * Get or create the storage folder
   */
  static async getQuestFolder() {
    let folder = game.folders.find(f => f.name === this.FOLDER_NAME && f.type === 'JournalEntry');
    if (!folder) {
      folder = await Folder.create({
        name: this.FOLDER_NAME,
        type: 'JournalEntry',
        color: '#c5a059',
        sorting: 'm'
      });
    }
    return folder;
  }

  /**
   * Default Data Schema for a new Quest
   */
  static get defaultQuestData() {
    return {
      type: "quest",
      title: "New Quest",
      category: "main", // main, side, personal
      description: "",
      category: "main", // main, side, personal
      description: "",
      source: { uuid: "", name: "", img: "" }, // Deprecated, kept for migration
      givers: [], // Array of { uuid, name, img }
      status: "draft", // active, completed, failed, available, draft
      acceptedBy: [],  // Array of userIds who accepted this quest individually
      visibleTo: [],    // User IDs (Legacy? Use visibility field + Permissions)
      visibility: "always", // always, gm, date
      syncWithCalendar: false,
      objectives: [],   // { id, text, completed }
      rewards: [],      // { type, uuid, quantity, ... }
      xp: 0,
      gold: 0,
      sort: 0,
      dates: {
        created: null,
        start: "",
        completed: null
      }
    };
  }

  /**
   * Create a new Quest
   */
  static async createQuest(data = {}) {
    this.pendingCreation = true;
    
    const folder = await this.getQuestFolder();
    const defaults = this.defaultQuestData;
    const questData = foundry.utils.mergeObject(defaults, data);
    
    // Default created date
    if (!questData.dates.created) {
       questData.dates.created = Date.now();
    }

    // Create Journal Entry
    const entry = await JournalEntry.create({
      name: questData.title,
      content: questData.description,
      folder: folder ? folder.id : null,
      flags: {
        [this.ID]: {
          [this.FLAG]: questData
        }
      }
    });

    return entry;
  }

  /**
   * Get all Quests
   */
  static getQuests() {
    const folder = game.folders.find(f => f.name === this.FOLDER_NAME && f.type === 'JournalEntry');
    if (!folder) return [];
    
    // Filter contents that are actually our quests
    return folder.contents.filter(e => {
      const flag = e.getFlag(this.ID, this.FLAG);
      return flag && flag.type === 'quest';
    });
  }

  /**
   * Update a Quest
   */
  static async updateQuest(questId, updateData) {
    const entry = game.journal.get(questId);
    if (!entry) return;

    const currentData = entry.getFlag(this.ID, this.FLAG);
    const newData = foundry.utils.mergeObject(currentData, updateData);

    // If title or description changed, update main document too
    const docUpdate = {};
    if (updateData.title) docUpdate.name = updateData.title;
    if (updateData.description) docUpdate.content = updateData.description; // Note: JournalEntires use pages in V10+, wait. V12 uses Pages.
    // ... working version logic retained ...

    // We update the flag
    await entry.setFlag(this.ID, this.FLAG, newData);
    
    // Integrations
    if (updateData.status === 'completed' && currentData.status !== 'completed') {
      await this.handleQuestCompletion(entry, newData);
    }
  }

  static async acceptQuest(questId, userId) {
    const quest = game.journal.get(questId);
    if (!quest) return;
    const data = quest.getFlag(this.ID, this.FLAG) || {};
    const acceptedBy = new Set(data.acceptedBy || []);
    acceptedBy.add(userId);
    await this.updateQuest(questId, { acceptedBy: Array.from(acceptedBy) });
  }

  /**
   * Check Visibility for all Date-Triggered Quests
   * Called by hook on worldTime update
   */
  static async checkVisibility() {
      if (!game.user.isGM) return;

      const quests = this.getQuests();
      for (const entry of quests) {
          const data = entry.getFlag(this.ID, this.FLAG);
          if (data.visibility === 'date' && data.dates.start) {
              await this.updateQuestPermissions(entry, data);
          }
      }
  }

  /**
   * Update Quest Permissions based on Visibility Setting
   */
  static async updateQuestPermissions(entry, data) {
      if (!game.user.isGM) return;

      let newLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;

      if (data.visibility === 'always') {
          newLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
      } else if (data.visibility === 'gm') {
          newLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
      } else if (data.visibility === 'date') {
          // Check Date
          if (!data.dates.start) {
              newLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
          } else {
              // Parse Start Date
              const start = this._parseDate(data.dates.start);
              /* If PDNC is missing, default to NONE */
              newLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;

              if (start && window.PhilsDayNightCycle) {
                   const calendar = window.PhilsDayNightCycle.calendar;
                   // Get current date object
                   // We need to compare specific Y/M/D.
                   const dateData = calendar.getDate(game.time.worldTime); 
                   
                   const currentVal = (dateData.year * 10000) + (dateData.month * 100) + dateData.day;
                   const startVal = (start.year * 10000) + (start.month * 100) + start.day;
                   
                   if (currentVal >= startVal) {
                       newLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;

                       // Auto-Promote Status
                       if (data.status === 'available') {
                           entry.setFlag(this.ID, this.FLAG, { status: 'active' });
                           if (ui.notifications) ui.notifications.info(`Quest '${data.title}' is now Active!`);
                       }
                   } 
                   /* Else remains NONE */
              }
          }
      }

      // Update Default Permission
      if (entry.ownership.default !== newLevel) {
          await entry.update({ "ownership.default": newLevel });
      }
  }

  /**
   * Handle Quest Completion Integrations
   */
  static async handleQuestCompletion(quest, data) {
    // 1. Chat Message
    const content = `
      <div class="pqt-chat-card">
        <h3>${game.i18n.format("PQT.Message.QuestCompleted", { title: data.title })}</h3>
        ${data.source.img ? `<img src="${data.source.img}" class="pqt-chat-img"/>` : ''}
        ${(data.xp > 0 || data.gold > 0) ? `
        <div class="pqt-values-row" style="display: flex; gap: 10px; margin-bottom: 5px; align-items: center;">
            ${data.gold > 0 ? `<div class="pqt-gold-reward" style="font-weight: bold; color: #ffd700;"><i class="fas fa-coins"></i> ${data.gold}</div>` : ''}
            ${data.xp > 0 ? `<div class="pqt-xp-reward" style="font-weight: bold; color: #b1853d;">${data.xp} XP</div>` : ''}
        </div>` : ''}
        <div class="pqt-rewards">
          ${data.rewards.map(r => {
            if (r.uuid) {
                // Draggable Link
                return `
                <div class="pqt-reward-item">
                   <span class="pqt-reward-qty">${r.quantity}x</span> @UUID[${r.uuid}]{${r.name}}
                </div>`;
            } else {
                // Fallback / Text only
                return `
                <div class="pqt-reward-item">
                   <img src="${r.img}" width="24" height="24"/>
                   <span>${r.quantity}x ${r.name}</span>
                </div>`;
            }
          }).join('')}
        </div>
      </div>
    `;

    ChatMessage.create({
      content: content,
      speaker: ChatMessage.getSpeaker({ alias: "Quest Tracker" })
    });

    // 2. Calendar Integration
    if (data.syncWithCalendar && data.dates.completed) {
      // The updateJournalEntry hook will handle the actual event creation
      // because we just set the flag above.
    }
  }

  // --- Calendar Sync Helpers ---

  static _parseDate(dateStr) {
    if (!dateStr) return null;
    
    // Try YYYY-MM-DD (Year first, 1+ digits)
    let match = dateStr.match(/^(\d+)[\.\-\/](\d{1,2})[\.\-\/](\d{1,2})$/);
    if (match) {
        return { year: parseInt(match[1]), month: parseInt(match[2]) - 1, day: parseInt(match[3]) };
    }

    // Try DD.MM.YYYY (Year last, 1+ digits)
    match = dateStr.match(/^(\d{1,2})[\.\-\/]\s*(\d{1,2})[\.\-\/]\s*(\d+)$/);
    if (match) {
        return { year: parseInt(match[3]), month: parseInt(match[2]) - 1, day: parseInt(match[1]) };
    }

    return null;
  }

  static async addToCalendar(questData, questId) {
     if (!game.user.isGM) return;
     if (!window.PhilsDayNightCycle || !questData.syncWithCalendar) return;

     // 1. Start Date
     const start = this._parseDate(questData.dates.start);
     if (start) {
         // Prevention: Remove existing linked event to handle Renames/Date Changes (Upsert)
         if (window.PhilsDayNightCycle.removeLinkedEvent) {
             await window.PhilsDayNightCycle.removeLinkedEvent(questId);
         }

         // Calculate Visibility (GM Only or Future Date)
         let isHidden = (questData.visibility === 'gm');
         if (questData.visibility === 'date') {
             const calendar = window.PhilsDayNightCycle.calendar;
             const dateData = calendar.getDate(game.time.worldTime); 
             const currentVal = (dateData.year * 10000) + (dateData.month * 100) + dateData.day;
             const startVal = (start.year * 10000) + (start.month * 100) + start.day;
             if (currentVal < startVal) isHidden = true;
         }

         const dateKey = `${start.year}-${start.month}-${start.day}`;
         await window.PhilsDayNightCycle.addEvent(dateKey, {
             title: `Start: ${questData.title}`,
             description: (questData.description || "").replace(/<\/p>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim(),
             type: 'quest', // Gold styling
             gmOnly: isHidden, // Dynamic Hidden Status
             documentId: questId, // Add ID for click handling
             timestamp: questData.dates.created || Date.now(),
             link: questId ? `@JournalEntry[${questId}]{Open Quest}` : null // Link for chat
         });
     }

     // 2. Completion Date
     // (Placeholder for future completion timestamp parsing)
     if (questData.dates.completed && questData.dates.completed.date) {
         // Logic pending
     }
  }

  static async removeFromCalendar(questId, questData) {
      if (!game.user.isGM) return;
      if (!window.PhilsDayNightCycle) return;

      let removed = false;
      // 1. Try ID Link Removal (Preferred) with Quest ID
      if (window.PhilsDayNightCycle.removeLinkedEvent && questId) {
           removed = await window.PhilsDayNightCycle.removeLinkedEvent(String(questId));

      }

      // 2. Fallback: Title/Date
      if (!removed && questData && questData.dates?.start && questData.title) {
          const start = this._parseDate(questData.dates.start);
          if (start) {
              const dateKey = `${start.year}-${start.month}-${start.day}`;
              await window.PhilsDayNightCycle.removeEvent(dateKey, `Start: ${questData.title}`);
          }
      }
  }

  /**
   * Export all quests to a JSON file
   */
  static async exportQuests() {
    const quests = this.getQuests();
    const data = quests.map(q => q.getFlag(this.ID, this.FLAG));
    
    saveDataToFile(JSON.stringify(data, null, 2), "json", "quest-tracker-backup.json");
  }

  /**
   * Import quests from JSON data
   * @param {Array} data Array of quest data objects
   */
  static async importQuests(data) {
    if (!Array.isArray(data)) {
      ui.notifications.error("Invalid data format.");
      return;
    }

    let count = 0;
    for (const questData of data) {
      // Basic validation
      if (!questData.title) continue;
      
      await this.createQuest(questData);
      count++;
    }
  }

}
