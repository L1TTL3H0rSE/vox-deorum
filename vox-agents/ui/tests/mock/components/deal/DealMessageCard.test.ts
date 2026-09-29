import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import DealMessageCard from '@/components/deal/DealMessageCard.vue';
import type { DealTranscriptMessage } from '@/utils/types';
import type { ProposalOutcome } from '@/utils/types';
import { ButtonStub } from '../../../helpers/stubs.js';

function dealMsg(over: Partial<DealTranscriptMessage> = {}): DealTranscriptMessage {
  return {
    ID: 5,
    Player1ID: 0,
    Player2ID: 1,
    Player1Role: 'the leader',
    Player2Role: 'diplomat',
    SpeakerID: 0,
    MessageType: 'deal-proposal',
    Content: '',
    Payload: {
      Deal: {
        version: 1,
        items: [
          { fromPlayerID: 0, toPlayerID: 1, itemType: 'GOLD', amount: 100 },
          { fromPlayerID: 1, toPlayerID: 0, itemType: 'MAPS' },
        ],
        promises: [],
      },
      Value1: { '0': 100, '1': 20 },
      Value2: { '0': 90, '1': 18 },
    },
    Turn: 7,
    CreatedAt: 1,
    ...over,
  };
}

function outcomeMsg(over: Partial<DealTranscriptMessage> = {}): DealTranscriptMessage {
  return { ...dealMsg(), ID: 90, MessageType: 'deal-reject', SpeakerID: 1, Content: '', Payload: {}, ...over };
}

/** The per-proposal outcome the parent derives with `deriveProposalOutcomes`. */
function outcome(over: Partial<ProposalOutcome> = {}): ProposalOutcome {
  return { status: 'open', responses: [], superseded: false, ...over };
}

function mountCard(props: Record<string, unknown> = {}) {
  return mount(DealMessageCard, {
    props: {
      deal: dealMsg(),
      youID: 0,
      themID: 1,
      youLabel: 'You',
      themLabel: 'Germany',
      outcome: outcome(),
      ...props,
    },
    global: { stubs: { Button: ButtonStub }, directives: { tooltip: {} } },
  });
}

describe('DealMessageCard', () => {
  it('renders an outgoing proposal with you/them terms and value to you', () => {
    const wrapper = mountCard();
    expect(wrapper.text()).toContain('You proposed a deal');
    expect(wrapper.text()).toContain('Gold: 100'); // you give
    expect(wrapper.text()).toContain('Maps'); // they give
    // value to you from stored Value1 (you == player1): receive 20 (maps), give 100 (gold) → −80
    expect(wrapper.text()).toContain('value to You: -80');
  });

  it('offers Counter/Retract (not Accept) for my own active proposal', () => {
    const wrapper = mountCard();
    const labels = wrapper.findAll('button').map((b) => b.text());
    expect(labels).toContain('Counter');
    expect(labels).toContain('Retract');
    expect(labels).not.toContain('Accept');
  });

  it('offers Accept/Counter/Reject for an incoming active proposal and emits ID', async () => {
    const wrapper = mountCard({ deal: dealMsg({ SpeakerID: 1 }) });
    const labels = wrapper.findAll('button').map((b) => b.text());
    expect(labels).toEqual(expect.arrayContaining(['Accept', 'Counter', 'Reject']));

    await wrapper.findAll('button').find((b) => b.text() === 'Accept')!.trigger('click');
    expect(wrapper.emitted('accept')?.[0]).toEqual([5]);
  });

  it('shows superseded and no actions for a proposal that was never answered', () => {
    const wrapper = mountCard({ outcome: outcome({ superseded: true }) });
    expect(wrapper.text()).toContain('superseded');
    expect(wrapper.findAll('button')).toHaveLength(0);
  });

  it('absorbs the rejection line into the proposal card instead of a separate card', () => {
    // The reject row is filtered out of the stream upstream; its voiced line arrives here as one of
    // this proposal's responses, so the whole exchange reads as a single card.
    const wrapper = mountCard({
      deal: dealMsg({ SpeakerID: 1 }),
      outcome: outcome({
        status: 'rejected',
        responses: [outcomeMsg({ Content: 'We must decline this.' })],
      }),
    });
    expect(wrapper.text()).toContain('Germany proposed a deal');
    expect(wrapper.text()).toContain('We must decline this.');
    expect(wrapper.text()).toContain('Rejected');
    expect(wrapper.findAll('button')).toHaveLength(0);
  });

  it('keeps its outcome after a newer proposal supersedes it', () => {
    // Regression: this card used to fall back to "superseded", so the acceptance survived only in
    // the standalone outcome rows the card now absorbs.
    const wrapper = mountCard({
      deal: dealMsg({ SpeakerID: 1 }),
      outcome: outcome({
        status: 'enacted',
        superseded: true,
        responses: [
          outcomeMsg({ ID: 91, MessageType: 'deal-accept', Content: 'We accept your terms.' }),
          outcomeMsg({ ID: 92, MessageType: 'deal-enacted', Content: 'The deal was enacted.' }),
        ],
      }),
    });
    expect(wrapper.text()).toContain('Enacted');
    expect(wrapper.text()).not.toContain('superseded');
    // The accept line is the agent's own words; the enacted line is boilerplate the label covers.
    expect(wrapper.text()).toContain('We accept your terms.');
    expect(wrapper.text()).not.toContain('The deal was enacted.');
  });
});
