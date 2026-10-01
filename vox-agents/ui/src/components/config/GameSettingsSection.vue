<script setup lang="ts">
import Card from 'primevue/card';
import Checkbox from 'primevue/checkbox';
import type { VoxAgentsConfig } from '@/utils/types';

const props = defineProps<{ config: VoxAgentsConfig }>();
const emit = defineEmits<{ 'update:config': [value: VoxAgentsConfig] }>();

/** Update the launch setting without mutating the route-owned configuration. */
function updateUseDX11(value: boolean): void {
  emit('update:config', { ...props.config, useDX11: value });
}
</script>

<template>
  <Card class="config-card">
    <template #title><i class="pi pi-desktop" /> Game Settings</template>
    <template #subtitle>How Vox Deorum launches Civilization V</template>
    <template #content>
      <div class="field-row">
        <label for="useDX11">Use DX11
          <span class="help-icon" v-tooltip.top="'Launch the DirectX 11 build of Civilization V. Installs without that build fall back to the standard one.'"><i class="pi pi-question-circle" /></span>
        </label>
        <Checkbox inputId="useDX11" :binary="true" :modelValue="config.useDX11 !== false"
          @update:modelValue="updateUseDX11($event === true)" />
      </div>
    </template>
  </Card>
</template>

<style scoped>
.field-row label { min-width: 170px; }
.help-icon { color: var(--p-text-muted-color); font-size: 0.875rem; margin-left: 0.25rem; vertical-align: middle; }
</style>
