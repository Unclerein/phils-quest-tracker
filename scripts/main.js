import { QuestManager } from './quest-manager.js';
import { QuestLogApp } from './apps/quest-log-app.js';
import { QuestSheet } from './apps/quest-sheet.js';
import { QuestTrackerConfig } from './apps/quest-tracker-config.js';
import { QuestBoardApp } from './apps/quest-board-app.js';

class QuestBoardTile extends foundry.canvas.placeables.Tile {
  async _draw(options) {
    await super._draw(options);
    if (this.document.getFlag('phils-quest-tracker', 'isQuestBoard')) {
      this.eventMode = 'static';
      this.cursor = 'pointer';
    }
  }

  _onClickLeft(event) {
    if (!this.document.getFlag('phils-quest-tracker', 'isQuestBoard')) {
      return super._onClickLeft(event);
    }
    const shiftKey = event.originalEvent?.shiftKey ?? event.shiftKey ?? false;
    if (!shiftKey) return super._onClickLeft(event);
    event.stopPropagation();
    new QuestBoardApp(this.document).render(true);
  }
}

Hooks.once('init', () => {
  console.log('Phils Quest Tracker | Initializing module');

  CONFIG.Tile.objectClass = QuestBoardTile;

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

Hooks.on('renderTileHUD', (hud, html) => {
  if (!game.user.isGM) return;
  const tile = hud.object;
  if (!tile) return;
  const isBoard = tile.document.getFlag('phils-quest-tracker', 'isQuestBoard') ?? false;

  const btn = document.createElement('div');
  btn.classList.add('control-icon', 'pqt-board-toggle');
  if (isBoard) btn.classList.add('active');
  btn.dataset.tooltip = game.i18n.localize('PQT.Tile.ToggleBoard');
  btn.innerHTML = '<i class="fas fa-scroll"></i>';

  btn.addEventListener('click', async () => {
    if (isBoard) {
      await tile.document.unsetFlag('phils-quest-tracker', 'isQuestBoard');
    } else {
      await tile.document.setFlag('phils-quest-tracker', 'isQuestBoard', true);
      const pinned = tile.document.getFlag('phils-quest-tracker', 'pinnedQuests');
      if (!pinned) await tile.document.setFlag('phils-quest-tracker', 'pinnedQuests', []);
    }
    hud.render();
  });

  const colRight = html.querySelector('.col.right');
  if (colRight) colRight.appendChild(btn);
});

Hooks.once('ready', () => {
  console.log('Phils Quest Tracker | Ready');

  game.socket.on('module.phils-quest-tracker', async (data) => {
    if (!game.user.isGM) return;
    if (data.type === 'acceptQuest') {
      await QuestManager.acceptQuest(data.questId, data.userId);
    }
  });

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a.pqt-quest-link');
    if (!link) return;
    event.preventDefault();
    const uuid = link.dataset.uuid;
    const doc = fromUuidSync(uuid);
    if (doc) new QuestSheet(doc).render(true);
  });

  window.PhilsQuestTracker = {
    openQuest: async (questId) => {
      const quest = game.journal.get(questId);
      if (quest) new QuestSheet(quest).render(true);
    }
  };

  const reRenderAll = (doc) => {
    if (doc.documentName !== 'JournalEntry') return;
    for (const app of foundry.applications.instances.values()) {
      if (app instanceof QuestLogApp) app.render();
      if (app instanceof QuestBoardApp) app.render();
    }
  };

  Hooks.on('createJournalEntry', (doc) => {
    reRenderAll(doc);
    if (QuestManager.pendingCreation) {
      const isQuest = doc.getFlag(QuestManager.ID, QuestManager.FLAG)?.type === 'quest';
      if (isQuest && doc.isOwner) {
        new QuestSheet(doc).render(true);
        QuestManager.pendingCreation = false;
      }
    }
  });
  Hooks.on('updateJournalEntry', reRenderAll);
  Hooks.on('deleteJournalEntry', reRenderAll);
});

// Players can't interact with the tile layer, so we listen at the canvas level.
// Shift+right-click on a quest board tile opens the board interface.
let _boardClickHandler = null;
Hooks.on('canvasReady', () => {
  if (game.user.isGM) return;

  const canvasEl = canvas.app.canvas ?? canvas.app.view;
  if (_boardClickHandler) canvasEl.removeEventListener('contextmenu', _boardClickHandler, true);

  _boardClickHandler = (event) => {
    if (!event.shiftKey) return;
    if (!canvas.tiles?.placeables?.length) return;

    // Convert client coordinates to canvas world coordinates.
    // Try Foundry's own utility first, then fall back to the stage transform.
    let worldPoint;
    try {
      if (typeof canvas.canvasCoordinatesFromClient === 'function') {
        worldPoint = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
      } else {
        const rect = canvasEl.getBoundingClientRect();
        // Ratio of renderer logical pixels to CSS pixels (handles zoom/HiDPI)
        const scaleX = canvas.app.renderer.width  / rect.width;
        const scaleY = canvas.app.renderer.height / rect.height;
        worldPoint = canvas.stage.toLocal(
          new PIXI.Point(
            (event.clientX - rect.left) * scaleX,
            (event.clientY - rect.top)  * scaleY
          )
        );
      }
    } catch(e) { return; }

    for (const tile of canvas.tiles.placeables) {
      if (!tile.document.getFlag('phils-quest-tracker', 'isQuestBoard')) continue;
      // tile.bounds is a PIXI.Rectangle in world coords — reliable regardless of
      // how width/height are stored in the document schema (handles resizing).
      if (tile.bounds?.contains(worldPoint.x, worldPoint.y)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        new QuestBoardApp(tile.document).render(true);
        break;
      }
    }
  };

  // Capture phase so we intercept before Foundry's own contextmenu handler
  canvasEl.addEventListener('contextmenu', _boardClickHandler, true);
});
