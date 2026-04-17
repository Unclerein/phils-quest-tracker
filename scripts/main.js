import { QuestManager } from './quest-manager.js';
import { QuestLogApp } from './apps/quest-log-app.js';
import { QuestSheet } from './apps/quest-sheet.js';
import { QuestTrackerConfig } from './apps/quest-tracker-config.js';

Hooks.once('init', () => {
  console.log('Phils Quest Tracker | Initializing module');
  QuestManager.init();

  CONFIG.TextEditor.enrichers.push({
    pattern: /@Quest\[([^\]]+)\](?:\{([^}]+)\})?/gd,
    enricher: async (match, options) => {
      const uuid = match[1];
      const label = match[2];
      const doc = fromUuidSync(uuid);
      const title = label || doc?.name || uuid;
      const a = document.createElement('a');
      a.classList.add('pqt-quest-link');
      a.dataset.uuid = uuid;
      a.draggable = true;
      a.innerHTML = `<i class="fas fa-scroll"></i> ${title}`;
      return a;
    }
  });

  game.settings.registerMenu("phils-quest-tracker", "config", {
    name: "Quest Tracker Settings",
    label: "Open Settings",
    icon: "fas fa-cogs",
    type: QuestTrackerConfig,
    restricted: true
  });

  game.keybindings.register("phils-quest-tracker", "toggleQuestLog", {
    name: "PQT.Keybinding.Toggle.Name",
    hint: "PQT.Keybinding.Toggle.Hint",
    editable: [
      { key: "KeyL" }
    ],
    onDown: () => {
      // Check if an instance is already rendered
      // Using foundry.applications.instances for AppV2 compatibility
      let existingApp;
      for (const app of foundry.applications.instances.values()) {
        if (app.id === "phils-quest-log") {
          existingApp = app;
          break;
        }
      }

      if (existingApp && existingApp.rendered) {
        existingApp.close();
      } else {
        // If it exists but not rendered, render it. If not exists, create new.
        if (existingApp) existingApp.render(true);
        else new QuestLogApp().render(true);
      }
      return true;
    },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });
});

Hooks.on('renderJournalDirectory', (app, html, data) => {
  QuestLogApp.renderSidebarControl(app, html);
});

Hooks.once('ready', () => {
  console.log('Phils Quest Tracker | Ready');

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a.pqt-quest-link');
    if (!link) return;
    event.preventDefault();
    const uuid = link.dataset.uuid;
    const doc = fromUuidSync(uuid);
    if (doc) new QuestSheet(doc).render(true);
  });

  // Expose API
  window.PhilsQuestTracker = {
    openQuest: async (questId) => {
      const quest = game.journal.get(questId);
      if (quest) {
        new QuestSheet(quest).render(true);
      }
    }
  };
  
  // Reactivity: Re-render Quest Log when Journal Entries change
  const reRenderLog = (doc) => {
    if (doc.documentName !== 'JournalEntry') return;

    // Trigger render on all Quest Log instances
    // We skip the flag check to ensure deletion/updates are always caught
    for (const app of foundry.applications.instances.values()) {
      if (app instanceof QuestLogApp) app.render();
    }
  };

  Hooks.on('createJournalEntry', (doc) => {
      reRenderLog(doc);
      
      // Auto-Open Logic (Retained as it is good UX and client-side)
      if (QuestManager.pendingCreation) {
          const isQuest = doc.getFlag(QuestManager.ID, QuestManager.FLAG) && doc.getFlag(QuestManager.ID, QuestManager.FLAG).type === 'quest';
          if (isQuest && doc.isOwner) {
              new QuestSheet(doc).render(true);
              QuestManager.pendingCreation = false;
          }
      }
  });
  Hooks.on('updateJournalEntry', reRenderLog);
  Hooks.on('deleteJournalEntry', reRenderLog);
});
