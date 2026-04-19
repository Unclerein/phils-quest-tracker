import { QuestManager } from '../quest-manager.js';
import { QuestSheet } from './quest-sheet.js';

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

export class QuestBoardApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(tileDoc, options = {}) {
    super({ ...options, id: `phils-quest-board-${tileDoc.id}` });
    this.tileDoc = tileDoc;
  }

  static DEFAULT_OPTIONS = {
    classes: ['pqt-app', 'pqt-quest-board'],
    window: {
      title: 'PQT.Board.Title',
      icon: 'fas fa-scroll',
      resizable: true
    },
    position: {
      width: 720,
      height: 520
    },
    actions: {
      pinQuest:   QuestBoardApp.pinQuest,
      unpinQuest: QuestBoardApp.unpinQuest,
      openQuest:  QuestBoardApp.openQuest,
      acceptQuest: QuestBoardApp.acceptQuest
    }
  };

  static PARTS = {
    main: {
      template: 'modules/phils-quest-tracker/templates/quest-board.hbs',
      scrollable: ['.pqt-board-surface']
    }
  };

  async _prepareContext(options) {
    const pinnedIds = this.tileDoc.getFlag('phils-quest-tracker', 'pinnedQuests') || [];
    const quests = [];

    for (const questId of pinnedIds) {
      const entry = game.journal.get(questId);
      if (!entry) continue;
      const data = entry.getFlag('phils-quest-tracker', 'data');
      if (!data) continue;

      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = data.description || '';
      const plain = (tempDiv.textContent || tempDiv.innerText || '').trim();
      const excerpt = plain.length > 220 ? plain.slice(0, 220) + '…' : plain;

      quests.push({
        id: entry.id,
        title: data.title,
        descriptionExcerpt: excerpt,
        isAccepted:  data.status !== 'draft',
        isCompleted: data.status === 'completed',
        isFailed:    data.status === 'failed'
      });
    }

    return {
      quests,
      isGM: game.user.isGM,
      hasQuests: quests.length > 0
    };
  }

  /* ------------------------------------------- */
  /*  Actions                                    */
  /* ------------------------------------------- */

  static async pinQuest(event, target) {
    const pinnedIds = this.tileDoc.getFlag('phils-quest-tracker', 'pinnedQuests') || [];
    const available = QuestManager.getQuests().filter(q => {
      const data = q.getFlag('phils-quest-tracker', 'data');
      return data.status === 'draft' && !pinnedIds.includes(q.id);
    });

    if (!available.length) {
      ui.notifications.warn(game.i18n.localize('PQT.Board.NoDrafts'));
      return;
    }

    const opts = available.map(q => {
      const data = q.getFlag('phils-quest-tracker', 'data');
      return `<option value="${q.id}">${data.title}</option>`;
    }).join('');

    const questId = await DialogV2.prompt({
      window: { title: game.i18n.localize('PQT.Board.PinQuest') },
      content: `<div style="padding:8px 0"><label style="display:block;margin-bottom:4px">${game.i18n.localize('PQT.Board.SelectQuest')}</label><select name="questId" style="width:100%">${opts}</select></div>`,
      ok: {
        label: game.i18n.localize('PQT.Board.PinQuest'),
        callback: (event, button) => button.form.elements.questId.value
      }
    });

    if (!questId) return;

    await this.tileDoc.setFlag('phils-quest-tracker', 'pinnedQuests', [...pinnedIds, questId]);
    await QuestManager.updateQuest(questId, { visibility: 'always' });
    this.render();
  }

  static async unpinQuest(event, target) {
    const questId = target.closest('[data-quest-id]').dataset.questId;
    const pinnedIds = this.tileDoc.getFlag('phils-quest-tracker', 'pinnedQuests') || [];
    await this.tileDoc.setFlag('phils-quest-tracker', 'pinnedQuests', pinnedIds.filter(id => id !== questId));
    this.render();
  }

  static async openQuest(event, target) {
    const questId = target.closest('[data-quest-id]').dataset.questId;
    const quest = game.journal.get(questId);
    if (quest) new QuestSheet(quest).render(true);
  }

  static async acceptQuest(event, target) {
    event.stopPropagation();
    const card = target.closest('[data-quest-id]');
    if (!card) return;
    const questId = card.dataset.questId;
    if (game.user.isGM) {
      await QuestManager.acceptQuest(questId);
    } else {
      game.socket.emit('module.phils-quest-tracker', {
        type: 'acceptQuest',
        questId,
        userId: game.user.id
      });
    }
  }
}
