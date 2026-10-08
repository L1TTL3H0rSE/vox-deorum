<template>
  <div class="chat-messages-container">
    <div v-if="messages.length === 0" class="empty-state">
      <i class="pi pi-comments" style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.5"></i>
      <p>{{ emptyHint }}</p>
    </div>

    <VList
      v-else
      ref="virtualScroller"
      :data="visibleMessages"
      :overscan="3"
      class="virtual-list"
      @scroll="handleScroll"
    >
      <template #default="{ item, index }">
        <DealMessageCard
          v-if="item.deal"
          :key="`deal-${item.deal.ID}`"
          :deal="item.deal"
          :you-i-d="youID"
          :them-i-d="themID"
          :you-label="userLabel"
          :them-label="agentLabel"
          :outcome="dealOutcomes?.get(item.deal.ID)"
          :locked="dealLocked"
          :busy="dealActionBusy"
          @accept="$emit('deal-accept', $event)"
          @reject="$emit('deal-reject', $event)"
          @counter="$emit('deal-counter', $event)"
        />
        <ChatMessage
          v-else
          :key="`${item.message.role}-${index}`"
          :message="item.message"
          :metadata="item.metadata"
          :user-label="userLabel"
          :agent-label="agentLabel"
        />
      </template>
    </VList>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { VList } from 'virtua/vue';
import ChatMessage from './ChatMessage.vue';
import DealMessageCard from '../deal/DealMessageCard.vue';
import type { MessageWithMetadata, ProposalOutcome } from '@/utils/types';

interface Props {
  /** Rendered stream items: ordinary chat messages plus inline deal cards (a row's `deal`). */
  messages: MessageWithMetadata[];
  scrollTrigger?: number;
  /** Line shown in place of the stream while the thread is still empty. */
  emptyHint?: string;
  userLabel: string;
  agentLabel: string;
  /** Deal-card context: the viewer ("you") and the voiced ("them") endpoint IDs. */
  youID: number;
  themID: number;
  /** Per-proposal outcomes keyed by proposal ID, from `deriveProposalOutcomes`. Each card reads its
   *  own status here, so a resolved proposal keeps showing its outcome after being superseded. */
  dealOutcomes?: Map<number, ProposalOutcome>;
  /** Closed-this-turn lock disables deal-card actions. */
  dealLocked?: boolean;
  /** A deal action is currently in flight from the parent view. */
  dealActionBusy?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  scrollTrigger: 0,
  emptyHint: 'No messages yet. Start a conversation!'
});

defineEmits<{
  (e: 'deal-accept', id: number): void;
  (e: 'deal-reject', id: number): void;
  (e: 'deal-counter', id: number): void;
}>();

/** `deal-accept` / `deal-reject` / `deal-enacted` rows are dropped from the stream: they belong to
 *  the proposal they answer and are rendered inside its card, so one deal reads as one card. They
 *  must be filtered out of the list data rather than skipped in the template — the `v-else` branch
 *  would otherwise render them as ordinary chat bubbles, which is the split we are removing. */
const visibleMessages = computed(() =>
  props.messages.filter(
    (item) =>
      !item.deal ||
      item.deal.MessageType === 'deal-proposal' ||
      item.deal.MessageType === 'deal-counter'
  )
);

// Template refs
const virtualScroller = ref<InstanceType<typeof VList>>();

// State for user-scroll-aware auto-scroll
const userScrolledAway = ref(false);
let isProgrammaticScroll = false;

// Scroll to the absolute bottom of the scroll container.
// Uses scrollTo(scrollSize) instead of scrollToIndex to handle items that
// grow taller than the viewport during streaming.
const scrollToBottom = () => {
  if (!virtualScroller.value) return;
  isProgrammaticScroll = true;
  requestAnimationFrame(() => {
    if (!virtualScroller.value) return;
    virtualScroller.value.scrollTo(virtualScroller.value.scrollSize);
    // Clear the flag after the scroll event fires
    requestAnimationFrame(() => {
      isProgrammaticScroll = false;
    });
  });
};

// Detect user scrolling away from bottom to pause auto-scroll.
// Auto-scroll resumes when the user scrolls back within 100px of the bottom.
const handleScroll = () => {
  if (!virtualScroller.value || isProgrammaticScroll) return;

  const scroller = virtualScroller.value;
  const distanceFromBottom = scroller.scrollSize - scroller.scrollOffset - scroller.viewportSize;
  userScrolledAway.value = distanceFromBottom > 100;
};

// Auto-scroll on streaming chunks (scrollTrigger) AND whenever the rendered list grows. The latter
// covers rows that arrive without a streamed text/tool delta: the optimistic user row, the committed
// deal card inserted on `connected`, and the reconciled deal rows spliced in on `done`, none of which
// bump scrollTrigger, so a proposal turn would otherwise never scroll. scrollToBottom() is idempotent
// and respects the user-scrolled-away pause.
watch([() => props.scrollTrigger, () => props.messages.length], () => {
  if (!userScrolledAway.value && virtualScroller.value) {
    nextTick(() => {
      scrollToBottom();
    });
  }
});

onMounted(() => {
  nextTick(() => {
    scrollToBottom();
  });
});
</script>
