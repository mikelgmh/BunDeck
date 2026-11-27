<template>
  <section
    class="status-cards"
    :data-kind="kind"
    data-cy="widget-status-card"
    :aria-label="label || title"
    aria-live="polite"
  >
    <NeedsConfig v-if="!isConfigured" :action-type="props.action.type" :position="props.position" />
    <header class="sc-head">
      <span class="sc-title">
        <component :is="icon" :size="15" aria-hidden="true" />
        <span class="sc-title-text">{{ label || title }}</span>
      </span>
      <button
        v-if="canRefresh"
        class="sc-refresh"
        type="button"
        :aria-label="copy.refresh"
        :disabled="busy || readonly"
        @click="refresh"
      >
        <RefreshCw :size="14" :class="{ spin: busy }" aria-hidden="true" />
      </button>
    </header>

    <div v-if="busy && !loaded" class="sc-state" role="status">
      <LoaderCircle class="spin" :size="18" aria-hidden="true" /> {{ copy.loading }}
    </div>
    <div v-else-if="error && !data" class="sc-state sc-err" role="alert" :title="error">
      <TriangleAlert :size="18" aria-hidden="true" />
      <span class="err-short" aria-hidden="true">{{ copy.shortError }}</span>
      <span class="sr-only">{{ error }}</span>
      <span class="err-full" aria-hidden="true">{{ error }}</span>
      <button v-if="canRefresh" class="sc-retry hide-xs" type="button" :disabled="busy || readonly" @click="refresh">
        {{ copy.tryAgain }}
      </button>
    </div>
    <template v-else>
      <div v-if="kind === 'pc'" class="sc-body">
        <div v-if="data?.monitored === false" class="sc-muted">
          <CircleOff :size="19" aria-hidden="true" />
          <span>{{ data?.reason || copy.unavailable }}</span>
        </div>
        <template v-else-if="isSummary">
          <div v-if="carouselItems.length" class="xs-only xs-carousel">
            <strong class="bd-data-swap" :key="carousel.index.value" :title="carouselItems[carousel.index.value]?.main ?? ''">{{ carouselItems[carousel.index.value]?.main ?? '—' }}</strong>
            <span class="xs-sub">{{ carouselItems[carousel.index.value]?.sub }}</span>
            <div v-if="carouselItems.length > 1" class="sc-dots" role="tablist" :aria-label="copy.itemsLabel">
              <button
                v-for="(item, i) in carouselItems"
                :key="item.key"
                type="button"
                role="tab"
                class="sc-dot"
                :class="{ 'is-active': carousel.index.value === i }"
                :aria-selected="carousel.index.value === i"
                :aria-label="`${copy.itemsLabel} ${i + 1}/${carouselItems.length}`"
                data-cy="bd-carousel-dot"
                @click.stop="carousel.goTo(i)"
              />
            </div>
          </div>
          <div v-else class="xs-only sc-muted">
            <span>{{ copy.noData }}</span>
          </div>
          <div v-if="summaryMetrics.length" ref="metricsEl" class="metrics hide-xs">
            <div v-for="item in summaryMetrics" :key="item.name" class="metric" data-page-item>
              <span>{{ item.name }}</span><b>{{ metricText(item) }}</b>
            </div>
          </div>
          <div v-if="metricsPager.numPages.value > 1" class="sc-pager fit-pager hide-xs" role="tablist" :aria-label="copy.itemsLabel">
            <button
              v-for="i in metricsPager.numPages.value"
              :key="i"
              type="button"
              role="tab"
              class="sc-dot"
              :class="{ 'is-active': metricsPager.index.value === i - 1 }"
              :aria-selected="metricsPager.index.value === i - 1"
              :aria-label="`${copy.itemsLabel} ${i}/${metricsPager.numPages.value}`"
              data-cy="bd-carousel-dot"
              @click.stop="metricsPager.goTo(i - 1)"
            />
            <small>{{ metricsPager.index.value + 1 }}/{{ metricsPager.numPages.value }}</small>
          </div>
          <p v-else class="sc-muted hide-xs">{{ copy.noData }}</p>
        </template>
        <template v-else-if="isMonitor">
          <div class="hero-metric">
            <strong class="bd-data-swap" :key="String(data?.value ?? '')">{{ display(data?.value, data?.unit) }}</strong>
            <span>{{ data?.component || copy.metric }} {{ data?.metric || '' }}</span>
          </div>
        </template>
        <template v-else-if="suffix === 'fan-speed'">
          <div v-if="carouselItems.length" class="xs-only xs-carousel">
            <strong class="bd-data-swap" :key="carousel.index.value" :title="carouselItems[carousel.index.value]?.main ?? ''">{{ carouselItems[carousel.index.value]?.main ?? '—' }}</strong>
            <span class="xs-sub">{{ carouselItems[carousel.index.value]?.sub }}</span>
            <div v-if="carouselItems.length > 1" class="sc-dots" role="tablist" :aria-label="copy.itemsLabel">
              <button
                v-for="(item, i) in carouselItems"
                :key="item.key"
                type="button"
                role="tab"
                class="sc-dot"
                :class="{ 'is-active': carousel.index.value === i }"
                :aria-selected="carousel.index.value === i"
                :aria-label="`${copy.itemsLabel} ${i + 1}/${carouselItems.length}`"
                data-cy="bd-carousel-dot"
                @click.stop="carousel.goTo(i)"
              />
            </div>
          </div>
          <div v-else class="xs-only sc-muted">
            <span>{{ copy.noFans }}</span>
          </div>
          <div ref="fansEl" class="list hide-xs">
            <div v-for="fan in fanItems" :key="fan.name" data-page-item>
              <span>{{ fan.name || copy.fan }}</span><b>{{ display(fan.value, fan.unit || 'RPM') }}</b>
            </div>
            <p v-if="!fanItems.length" class="sc-muted">{{ copy.noFans }}</p>
          </div>
          <div v-if="fansPager.numPages.value > 1" class="sc-pager fit-pager hide-xs" role="tablist" :aria-label="copy.itemsLabel">
            <button
              v-for="i in fansPager.numPages.value"
              :key="i"
              type="button"
              role="tab"
              class="sc-dot"
              :class="{ 'is-active': fansPager.index.value === i - 1 }"
              :aria-selected="fansPager.index.value === i - 1"
              :aria-label="`${copy.itemsLabel} ${i}/${fansPager.numPages.value}`"
              data-cy="bd-carousel-dot"
              @click.stop="fansPager.goTo(i - 1)"
            />
            <small>{{ fansPager.index.value + 1 }}/{{ fansPager.numPages.value }}</small>
          </div>
        </template>
        <template v-else-if="suffix === 'disk-usage'">
          <div class="disk">
            <div class="disk-label">
              <b class="bd-data-swap" :key="String(data?.value ?? '')">{{ display(data?.value, '%') }}</b>
              <span class="hide-xs">{{ data?.path || copy.disk }}</span>
            </div>
            <div class="bar hide-xs" role="meter" :aria-valuenow="number(data?.value)" aria-valuemin="0" aria-valuemax="100">
              <i class="bd-meter-fill" :style="{ width: `${clampPercent(data?.value)}%` }" />
            </div>
            <small class="hide-xs">{{ data?.usedGB ?? '—' }} / {{ data?.totalGB ?? '—' }} GB {{ copy.used }}</small>
          </div>
        </template>
        <template v-else-if="suffix === 'net-speed'">
          <div class="hero-metric network">
            <strong class="bd-data-swap" :key="String(data?.value ?? '')">{{ display(data?.value, data?.unit || 'KB/s') }}</strong>
            <span class="hide-xs">↓ {{ display(data?.downKBs, 'KB/s') }} &nbsp; ↑ {{ display(data?.upKBs, 'KB/s') }}</span>
          </div>
        </template>
        <template v-else-if="suffix === 'uptime'">
          <div class="hero-metric">
            <strong class="bd-data-swap" :key="data?.human ?? ''">{{ data?.human || '—' }}</strong><span>{{ copy.systemUptime }}</span>
          </div>
        </template>
        <template v-else-if="suffix === 'process-top'">
          <div v-if="carouselItems.length" class="xs-only xs-carousel">
            <strong class="bd-data-swap" :key="carousel.index.value" :title="carouselItems[carousel.index.value]?.main ?? ''">{{ carouselItems[carousel.index.value]?.main ?? '—' }}</strong>
            <span class="xs-sub">{{ carouselItems[carousel.index.value]?.sub }}</span>
            <div v-if="carouselItems.length > 1" class="sc-dots" role="tablist" :aria-label="copy.itemsLabel">
              <button
                v-for="(item, i) in carouselItems"
                :key="item.key"
                type="button"
                role="tab"
                class="sc-dot"
                :class="{ 'is-active': carousel.index.value === i }"
                :aria-selected="carousel.index.value === i"
                :aria-label="`${copy.itemsLabel} ${i + 1}/${carouselItems.length}`"
                data-cy="bd-carousel-dot"
                @click.stop="carousel.goTo(i)"
              />
            </div>
          </div>
          <div v-else class="xs-only sc-muted">
            <span>{{ copy.noProcesses }}</span>
          </div>
          <div ref="processEl" class="list process-list hide-xs">
            <div v-for="(proc, index) in processItems" :key="proc.pid || proc.name || index" data-page-item>
              <span>{{ proc.name || proc.raw || 'Process' }}</span>
              <b>{{ proc.cpu != null ? `${proc.cpu}%` : proc.memory || '—' }}</b>
            </div>
            <p v-if="!processItems.length" class="sc-muted">{{ copy.noProcesses }}</p>
          </div>
          <div v-if="processPager.numPages.value > 1" class="sc-pager fit-pager hide-xs" role="tablist" :aria-label="copy.itemsLabel">
            <button
              v-for="i in processPager.numPages.value"
              :key="i"
              type="button"
              role="tab"
              class="sc-dot"
              :class="{ 'is-active': processPager.index.value === i - 1 }"
              :aria-selected="processPager.index.value === i - 1"
              :aria-label="`${copy.itemsLabel} ${i}/${processPager.numPages.value}`"
              data-cy="bd-carousel-dot"
              @click.stop="processPager.goTo(i - 1)"
            />
            <small>{{ processPager.index.value + 1 }}/{{ processPager.numPages.value }}</small>
          </div>
        </template>
      </div>

      <div v-else-if="kind === 'weather'" class="sc-body">
        <template v-if="suffix === 'forecast'">
          <div v-if="carouselItems.length" class="xs-only xs-carousel">
            <strong class="bd-data-swap" :key="carousel.index.value" :title="carouselItems[carousel.index.value]?.main ?? ''">{{ carouselItems[carousel.index.value]?.main ?? '—' }}</strong>
            <span class="xs-sub">{{ carouselItems[carousel.index.value]?.sub }}</span>
            <div v-if="carouselItems.length > 1" class="sc-dots" role="tablist" :aria-label="copy.itemsLabel">
              <button
                v-for="(item, i) in carouselItems"
                :key="item.key"
                type="button"
                role="tab"
                class="sc-dot"
                :class="{ 'is-active': carousel.index.value === i }"
                :aria-selected="carousel.index.value === i"
                :aria-label="`${copy.itemsLabel} ${i + 1}/${carouselItems.length}`"
                data-cy="bd-carousel-dot"
                @click.stop="carousel.goTo(i)"
              />
            </div>
          </div>
          <div v-else class="xs-only sc-muted">
            <span>{{ copy.noForecast }}</span>
          </div>
          <p v-if="data?.place" class="subheading hide-xs"><Marquee :text="data.place" /></p>
          <div ref="forecastEl" class="forecast hide-xs">
            <div v-for="day in forecastItems" :key="day.date" class="forecast-row" data-page-item>
              <span>{{ formatDay(day.date) }}</span><span>{{ weatherCondition(day.condition) }}</span>
              <b>{{ display(day.max, data?.unit) }} <small>/ {{ display(day.min, data?.unit) }}</small></b>
            </div>
            <p v-if="!forecastItems.length" class="sc-muted">{{ copy.noForecast }}</p>
          </div>
          <div v-if="forecastPager.numPages.value > 1" class="sc-pager fit-pager hide-xs" role="tablist" :aria-label="copy.itemsLabel">
            <button
              v-for="i in forecastPager.numPages.value"
              :key="i"
              type="button"
              role="tab"
              class="sc-dot"
              :class="{ 'is-active': forecastPager.index.value === i - 1 }"
              :aria-selected="forecastPager.index.value === i - 1"
              :aria-label="`${copy.itemsLabel} ${i}/${forecastPager.numPages.value}`"
              data-cy="bd-carousel-dot"
              @click.stop="forecastPager.goTo(i - 1)"
            />
            <small>{{ forecastPager.index.value + 1 }}/{{ forecastPager.numPages.value }}</small>
          </div>
        </template>
        <template v-else>
          <div class="xs-only xs-hero">
            <strong class="bd-data-swap" :key="String(data?.temperature ?? '')">{{ display(data?.temperature, data?.unit) }}</strong>
            <Marquee :text="weatherXsLine" />
          </div>
          <div class="weather-now hide-xs">
            <strong class="bd-data-swap" :key="String(data?.temperature ?? '')">{{ display(data?.temperature, data?.unit) }}</strong>
            <div><b>{{ data?.condition ? weatherCondition(data.condition, data.weatherCode) : copy.noConditions }}</b><span>{{ data?.place || copy.currentConditions }}</span></div>
          </div>
          <div class="weather-meta hide-xs">
            <span><Droplets :size="13" aria-hidden="true" /> {{ data?.humidity ?? '—' }}%</span>
            <span><Wind :size="13" aria-hidden="true" /> {{ data?.windKmh ?? '—' }} km/h</span>
          </div>
        </template>
      </div>

      <div v-else-if="kind === 'email'" class="sc-body">
        <template v-if="suffix === 'open-inbox'">
          <div class="xs-only xs-action">
            <button class="sc-iconbtn" type="button" :aria-label="copy.openInbox" :title="copy.openInbox" :disabled="busy || readonly" @click="openInbox">
              <Inbox :size="20" aria-hidden="true" />
            </button>
          </div>
          <div class="camera-state hide-xs"><Inbox :size="22" aria-hidden="true" /><span>{{ copy.openYourInbox }}</span></div>
          <button class="action-button hide-xs" type="button" :disabled="busy || readonly" @click="openInbox">
            <ExternalLink :size="15" aria-hidden="true" /> {{ copy.openInbox }}
          </button>
        </template>
        <template v-else>
          <div class="xs-only xs-line"><Marquee :text="unreadLine" /></div>
          <div class="count hide-xs"><strong class="bd-data-swap" :key="String(data?.count ?? '')">{{ data?.count ?? '—' }}</strong><span>{{ copy.unread }}</span></div>
          <button v-if="loaded && !error" class="action-button hide-xs" type="button" :disabled="busy || readonly" @click="openInbox">
            <Inbox :size="15" aria-hidden="true" /> {{ copy.openInbox }}
          </button>
        </template>
      </div>

      <div v-else-if="kind === 'slack'" class="sc-body">
        <template v-if="suffix === 'open-channel'">
          <div class="xs-only xs-action">
            <Marquee :text="`# ${parameters.channel || parameters.name || copy.chooseChannel}`" />
            <button v-if="parameters.channel" class="sc-iconbtn" type="button" :aria-label="copy.openChannel" :title="copy.openChannel" :disabled="busy || readonly" @click="openChannel(parameters.channel)">
              <ExternalLink :size="17" aria-hidden="true" />
            </button>
          </div>
          <p class="channel-name hide-xs"><Marquee :text="`# ${parameters.channel || parameters.name || copy.chooseChannel}`" /></p>
          <button v-if="parameters.channel" class="action-button hide-xs" type="button" :disabled="busy || readonly" @click="openChannel(parameters.channel)">
            <ExternalLink :size="15" aria-hidden="true" /> {{ copy.openChannel }}
          </button>
        </template>
        <template v-else-if="suffix === 'open-dm'">
          <div class="xs-only xs-action">
            <Marquee :text="String(parameters.user || copy.chooseUser)" />
            <button v-if="parameters.user" class="sc-iconbtn" type="button" :aria-label="copy.openDm" :title="copy.openDm" :disabled="busy || readonly" @click="openDm(parameters.user)">
              <ExternalLink :size="17" aria-hidden="true" />
            </button>
          </div>
          <p class="channel-name hide-xs"><Marquee :text="String(parameters.user || copy.chooseUser)" /></p>
          <button v-if="parameters.user" class="action-button hide-xs" type="button" :disabled="busy || readonly" @click="openDm(parameters.user)">
            <ExternalLink :size="15" aria-hidden="true" /> {{ copy.openDm }}
          </button>
        </template>
        <template v-else>
          <div v-if="carouselItems.length" class="xs-only xs-carousel">
            <strong class="bd-data-swap" :key="carousel.index.value" :title="carouselItems[carousel.index.value]?.main ?? ''">{{ carouselItems[carousel.index.value]?.main ?? '—' }}</strong>
            <span class="xs-sub">{{ carouselItems[carousel.index.value]?.sub }}</span>
            <div v-if="carouselItems.length > 1" class="sc-dots" role="tablist" :aria-label="copy.itemsLabel">
              <button
                v-for="(item, i) in carouselItems"
                :key="item.key"
                type="button"
                role="tab"
                class="sc-dot"
                :class="{ 'is-active': carousel.index.value === i }"
                :aria-selected="carousel.index.value === i"
                :aria-label="`${copy.itemsLabel} ${i + 1}/${carouselItems.length}`"
                data-cy="bd-carousel-dot"
                @click.stop="carousel.goTo(i)"
              />
            </div>
          </div>
          <div class="count hide-xs"><strong>{{ data?.total ?? '—' }}</strong><span>{{ copy.unreadMessages }}</span></div>
          <div v-if="data?.conversations?.length" class="list channel-list hide-xs">
            <button v-for="channel in data.conversations.slice(0, 3)" :key="channel.id" type="button" :disabled="busy || readonly" @click="openChannel(channel.id)">
              <span># {{ channel.name }}</span><b>{{ channel.unread }}</b>
            </button>
          </div>
        </template>
      </div>

      <div v-else-if="kind === 'minecraft'" class="sc-body">
        <div class="xs-only xs-status">
          <span class="server-dot" :class="{ online: data?.online }" aria-hidden="true" />
          <Marquee :text="serverLine" />
        </div>
        <div class="server-state hide-xs" :class="{ online: data?.online }">
          <i aria-hidden="true" /><strong>{{ data?.online ? copy.online : data?.online === false ? copy.offline : copy.unknown }}</strong>
        </div>
        <template v-if="suffix === 'server-status'">
          <div class="server-meta hide-xs"><span><Marquee :text="String(data?.host || parameters.host || '')" /></span><b v-if="data?.players">{{ data.players.online ?? 0 }} / {{ data.players.max ?? '?' }} {{ copy.players }}</b></div>
          <p v-if="data?.version" class="sc-muted hide-xs">Minecraft {{ data.version }}</p>
          <p v-if="data?.motd" class="motd hide-xs"><Marquee :text="String(data.motd)" /></p>
        </template>
        <div v-else class="latency hide-xs"><strong>{{ data?.latencyMs ?? '—' }}</strong><span>{{ copy.apiResponse }}</span></div>
      </div>

      <div v-else-if="kind === 'steam'" class="sc-body">
        <template v-if="suffix === 'presence'">
          <div class="xs-only sc-muted"><span>{{ copy.noPresence }}</span></div>
          <div class="unavailable hide-xs"><UsersRound :size="20" aria-hidden="true" /><span>{{ copy.presenceUnavailable }}</span></div>
        </template>
        <template v-else>
          <div class="xs-only xs-steam">
            <Marquee :text="String(data?.name || copy.steamApp)" />
            <small>{{ data?.price || (data?.isFree ? copy.free : copy.storeListing) }}</small>
          </div>
          <div class="steam-name hide-xs"><strong>{{ data?.name || copy.steamApp }}</strong><span>{{ data?.price || (data?.isFree ? copy.free : copy.storeListing) }}</span></div>
          <p v-if="data?.shortDescription" class="sc-muted description hide-xs">{{ data.shortDescription }}</p>
          <button v-if="parameters.appId" class="action-button hide-xs" type="button" :disabled="busy || readonly" @click="launchGame">
            <Play :size="15" aria-hidden="true" /> {{ copy.openSteam }}
          </button>
        </template>
      </div>

      <div v-else-if="kind === 'webcam'" class="sc-body">
        <div class="xs-only xs-action">
          <Camera :size="22" aria-hidden="true" class="xs-accent" />
          <button class="sc-iconbtn" type="button" :aria-label="data?.saved ? copy.takeAnother : copy.capturePhoto" :title="data?.saved ? copy.takeAnother : copy.capturePhoto" :disabled="busy || readonly" @click="takeSnapshot">
            <Camera :size="17" aria-hidden="true" />
          </button>
        </div>
        <div class="camera-state hide-xs"><Camera :size="23" aria-hidden="true" /><span>{{ data?.saved ? copy.snapshotCaptured : copy.cameraSnapshot }}</span></div>
        <p v-if="data?.saved" class="sc-muted hide-xs">{{ copy.photoSaved }}</p>
        <button class="action-button hide-xs" type="button" :disabled="busy || readonly" @click="takeSnapshot">
          <Camera :size="15" aria-hidden="true" /> {{ data?.saved ? copy.takeAnother : copy.capturePhoto }}
        </button>
      </div>

      <div v-else class="sc-body">
        <div class="sc-muted"><CircleOff :size="20" aria-hidden="true" /><span>{{ data?.note || copy.noStatus }}</span></div>
      </div>
      <p v-if="error" class="sc-inline-err sc-err" role="alert" :title="error">
        <TriangleAlert :size="13" aria-hidden="true" />
        <span class="err-short" aria-hidden="true">{{ copy.shortError }}</span>
        <span class="sr-only">{{ error }}</span>
        <span class="err-full" aria-hidden="true">{{ error }}</span>
      </p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  Activity, Bell, Camera, CircleOff, CloudSun, Cpu, Droplets, ExternalLink, Inbox, LoaderCircle,
  Mail, Monitor, Play, RefreshCw, Server, TriangleAlert, UsersRound, Wind,
} from 'lucide-vue-next'
import { executeWidgetAction } from '../../../composables/useWidgetAction'
import { useI18nStore } from '../../../composables/useI18n'
import { resolveCarouselMs, useAutoCarousel } from '../../../composables/useAutoCarousel'
import { useFitPager } from '../../../composables/useFitPager'
import Marquee from './shared/Marquee.vue'
import NeedsConfig from './shared/NeedsConfig.vue'

type WidgetAction = { type: string; parameters: Record<string, any> }
const props = withDefaults(defineProps<{
  action: WidgetAction
  apiBase: string
  label?: string
  readonly?: boolean
  /** Posición de la tecla: la reenvía a NeedsConfig para abrir el drawer. */
  position?: number | null
}>(), { label: '', readonly: false, position: null })
const { currentLocale } = useI18nStore()
const spanish = computed(() => String(currentLocale.value || 'es').toLowerCase().startsWith('es'))
const copy = computed(() => spanish.value
  ? {
      refresh: 'Actualizar estado', loading: 'Cargando estado…', tryAgain: 'Reintentar', metric: 'Métrica',
      shortError: 'Error', noData: 'Sin datos', itemsLabel: 'Elementos', noPresence: 'No disponible',
      unavailable: 'Métrica no disponible en este sistema', noFans: 'No se encontraron sensores de ventilador', fan: 'Ventilador',
      used: 'usados', systemUptime: 'Tiempo activo del sistema', noProcesses: 'No hay datos de procesos',
      noForecast: 'No hay datos del pronóstico', noConditions: 'Condiciones no disponibles',
      currentConditions: 'Condiciones actuales', openYourInbox: 'Abrir tu bandeja', openInbox: 'Abrir bandeja',
      unread: 'sin leer', unreadMessages: 'mensajes sin leer', chooseChannel: 'Elige un canal en los ajustes de la acción',
      openChannel: 'Abrir canal', chooseUser: 'Elige un usuario de Slack en los ajustes', openDm: 'Abrir mensaje directo',
      online: 'En línea', offline: 'Sin conexión', unknown: 'Desconocido', players: 'jugadores',
      apiResponse: 'ms de respuesta de API', presenceUnavailable: 'La presencia no está disponible sin credenciales de Steam Web API.',
      steamApp: 'Aplicación de Steam', free: 'Gratis', storeListing: 'Ficha de la tienda', openSteam: 'Abrir en Steam',
      snapshotCaptured: 'Foto capturada', cameraSnapshot: 'Foto de cámara', photoSaved: 'Foto guardada correctamente.',
      takeAnother: 'Tomar otra', capturePhoto: 'Capturar foto', noStatus: 'No hay datos de estado',
      cpu: 'CPU', ram: 'RAM', gpu: 'GPU', disk: 'Disco', uptime: 'Tiempo activo',
    }
  : {
      refresh: 'Refresh status', loading: 'Loading status…', tryAgain: 'Try again', metric: 'Metric',
      shortError: 'Error', noData: 'No data', itemsLabel: 'Items', noPresence: 'Unavailable',
      unavailable: 'Metric unavailable on this system', noFans: 'No fan sensors found', fan: 'Fan',
      used: 'used', systemUptime: 'System uptime', noProcesses: 'No process data',
      noForecast: 'No forecast data', noConditions: 'Conditions unavailable',
      currentConditions: 'Current conditions', openYourInbox: 'Open your inbox', openInbox: 'Open inbox',
      unread: 'unread', unreadMessages: 'unread messages', chooseChannel: 'Choose a channel in action settings',
      openChannel: 'Open channel', chooseUser: 'Choose a Slack user in action settings', openDm: 'Open direct message',
      online: 'Online', offline: 'Offline', unknown: 'Unknown', players: 'players',
      apiResponse: 'ms API response', presenceUnavailable: 'Presence is not available without Steam Web API credentials.',
      steamApp: 'Steam app', free: 'Free to play', storeListing: 'Store listing', openSteam: 'Open in Steam',
      snapshotCaptured: 'Snapshot captured', cameraSnapshot: 'Camera snapshot', photoSaved: 'Photo saved successfully.',
      takeAnother: 'Take another', capturePhoto: 'Capture photo', noStatus: 'No status data available',
      cpu: 'CPU', ram: 'RAM', gpu: 'GPU', disk: 'Disk', uptime: 'Uptime',
    })

const suffix = computed(() => props.action.type.split('.').pop() || props.action.type)
const plugin = computed(() => props.action.type.split('.')[0] || '')
const parameters = computed(() => props.action.parameters || {})
const busy = ref(false)
const loaded = ref(false)
const data = ref<any>(null)
const error = ref('')
let pollTimer: ReturnType<typeof setInterval> | undefined

const kind = computed(() => {
  if (plugin.value === 'pc-vitals') return 'pc'
  if (plugin.value === 'weather') return 'weather'
  if (plugin.value === 'email') return 'email'
  if (plugin.value === 'slack') return 'slack'
  if (plugin.value === 'minecraft') return 'minecraft'
  if (plugin.value === 'steam') return 'steam'
  if (plugin.value === 'webcam') return 'webcam'
  return 'unknown'
})
const title = computed(() => ({
  pc: spanish.value ? 'Estado del PC' : 'PC status',
  weather: spanish.value ? 'El tiempo' : 'Weather',
  email: spanish.value ? 'Correo' : 'Email',
  slack: 'Slack',
  minecraft: spanish.value ? 'Servidor de Minecraft' : 'Minecraft server',
  steam: 'Steam',
  webcam: spanish.value ? 'Cámara web' : 'Webcam',
  unknown: spanish.value ? 'Estado' : 'Status',
}[kind.value] || (spanish.value ? 'Estado' : 'Status')))
const icon = computed(() => ({
  pc: Cpu, weather: CloudSun, email: Mail, slack: Bell, minecraft: Server,
  steam: Monitor, webcam: Camera, unknown: Activity,
}[kind.value] || Activity))
const isSummary = computed(() => suffix.value === 'summary')
const isMonitor = computed(() => suffix.value === 'monitor')
const sideEffectOnly = computed(() =>
  kind.value === 'webcam' ||
  (kind.value === 'email' && suffix.value === 'open-inbox') ||
  (kind.value === 'slack' && ['open-channel', 'open-dm'].includes(suffix.value)),
)
const canRefresh = computed(() => !sideEffectOnly.value)

/**
 * Condición "sin configurar" por acción (solo parámetros propios; los
 * ajustes globales del plugin pueden aportar el resto y la acción cargará
 * igual: el badge solo molesta en la esquina hasta configurarlo).
 * - monitor: component+metric son required por schema.
 * - weather: place o latitud+longitud (o ajustes globales).
 * - slack.open-channel/open-dm, minecraft.*: channel/user/host required.
 * - steam.server-status: appId required.
 * - Resto: sin required (token/provider/url caen a ajustes) → configurado.
 */
const isConfigured = computed(() => {
  const p = parameters.value
  const text = (v: unknown) => typeof v === 'string' ? v.trim() : ''
  const num = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  if (plugin.value === 'pc-vitals' && suffix.value === 'monitor') return !!text(p.component) && !!text(p.metric)
  if (plugin.value === 'weather') return !!text(p.place) || (num(p.latitude) !== null && num(p.longitude) !== null)
  if (plugin.value === 'slack' && suffix.value === 'open-channel') return !!text(p.channel)
  if (plugin.value === 'slack' && suffix.value === 'open-dm') return !!text(p.user)
  if (plugin.value === 'minecraft') return !!text(p.host)
  if (plugin.value === 'steam' && suffix.value === 'server-status') return !!text(p.appId)
  return true
})

const summaryMetrics = computed(() => {
  const d = data.value
  return [
    { name: copy.value.cpu, value: d?.cpu, unit: '%' },
    { name: copy.value.ram, value: d?.ram, unit: '%' },
    { name: copy.value.gpu, value: d?.gpu?.usage, unit: '%' },
    { name: copy.value.disk, value: d?.disk?.value, unit: '%' },
    { name: copy.value.uptime, value: d?.uptime?.human, unit: '' },
  ].filter(item => item.value !== null && item.value !== undefined)
})
const fanItems = computed(() => (data.value?.fans ?? []).filter((f: any) => f && (f.name || f.value != null)))
const processItems = computed(() => data.value?.processes ?? [])
const forecastItems = computed(() => data.value?.daysForecast ?? [])

/** Elementos del carrusel en pequeño: un dato por pantalla (main + sub). */
const carouselItems = computed(() => {
  if (kind.value === 'pc' && isSummary.value) {
    return summaryMetrics.value.map(m => ({ key: `m-${m.name}`, main: metricText(m), sub: m.name }))
  }
  if (kind.value === 'pc' && suffix.value === 'fan-speed') {
    return fanItems.value.map((f: any, i: number) => ({
      key: `fan-${f.name ?? i}`, main: display(f.value, ''), sub: `${f.unit || 'RPM'} · ${String(f.name || copy.value.fan)}`,
    }))
  }
  if (kind.value === 'pc' && suffix.value === 'process-top') {
    return processItems.value.map((p: any, i: number) => ({
      key: `p-${p.pid ?? p.name ?? i}`,
      main: p.cpu != null ? `${p.cpu}%` : (p.memory || '—'),
      sub: String(p.name || p.raw || 'Process'),
    }))
  }
  if (kind.value === 'weather' && suffix.value === 'forecast') {
    return forecastItems.value.map((d: any) => ({
      key: `d-${d.date}`,
      main: `${display(d.max, '')}/${display(d.min, data.value?.unit)}`,
      sub: `${formatDay(d.date)} · ${weatherCondition(d.condition)}`,
    }))
  }
  if (kind.value === 'slack' && !['open-channel', 'open-dm'].includes(suffix.value)) {
    const convs = (data.value?.conversations ?? []).map((c: any) => ({
      key: `c-${c.id}`, main: String(c.unread ?? '—'), sub: `# ${c.name}`,
    }))
    return [{ key: 'total', main: String(data.value?.total ?? '—'), sub: copy.value.unreadMessages }, ...convs]
  }
  return []
})
/** Intervalo del carrusel: setting `carouselMs` (ausente=4000, <=0=off). */
const carouselMs = computed(() => resolveCarouselMs(parameters.value))
const carousel = useAutoCarousel(computed(() => carouselItems.value.length), { intervalMs: carouselMs })

/**
 * Listas M+ sin scroll: páginas que rotan con `carouselMs` cuando no caben
 * (mismo mecanismo en métricas, ventiladores, procesos y pronóstico).
 */
const metricsEl = ref<HTMLElement | null>(null)
const fansEl = ref<HTMLElement | null>(null)
const processEl = ref<HTMLElement | null>(null)
const forecastEl = ref<HTMLElement | null>(null)
const metricsPager = useFitPager(metricsEl, { intervalMs: carouselMs })
const fansPager = useFitPager(fansEl, { intervalMs: carouselMs })
const processPager = useFitPager(processEl, { intervalMs: carouselMs })
const forecastPager = useFitPager(forecastEl, { intervalMs: carouselMs })
function measureLists() {
  metricsPager.measure()
  fansPager.measure()
  processPager.measure()
  forecastPager.measure()
}
watch([summaryMetrics, fanItems, processItems, forecastItems], () => {
  void nextTick().then(measureLists)
})

/** Línea compacta "Sin leer · N" para email.unread en pequeño. */
const unreadLine = computed(() => {
  const label = copy.value.unread
  const head = label ? label.charAt(0).toUpperCase() + label.slice(1) : ''
  return `${head} · ${data.value?.count ?? '—'}`
})
const weatherXsLine = computed(() => {
  const condition = data.value?.condition ? weatherCondition(data.value.condition, data.value.weatherCode) : copy.value.noConditions
  const place = data.value?.place || copy.value.currentConditions
  return `${condition} · ${place}`
})
const serverLine = computed(() => {
  const state = data.value?.online ? copy.value.online : data.value?.online === false ? copy.value.offline : copy.value.unknown
  const host = data.value?.host || parameters.value.host || ''
  const players = data.value?.players ? ` · ${data.value.players.online ?? 0}/${data.value.players.max ?? '?'} ${copy.value.players}` : ''
  return `${state} · ${host}${players}`
})

// The values match each source action's manifest pollMs where one exists.
const pollMs = computed(() => {
  if (plugin.value === 'calendar') return 60_000
  if (plugin.value === 'pc-vitals') {
    if (suffix.value === 'summary') return 5_000
    if (suffix.value === 'monitor') return Math.max(2_000, Number(parameters.value.updateInterval) || 2_000)
    return suffix.value === 'net-speed' ? 60_000 : 30_000
  }
  if (plugin.value === 'weather') return 600_000
  if (plugin.value === 'email') return 300_000
  if (plugin.value === 'slack') return 120_000
  if (plugin.value === 'minecraft') return 120_000
  if (plugin.value === 'steam') return suffix.value === 'presence' ? 0 : 300_000
  return 0
})

function actionType(name: string) { return `${plugin.value}.${name}` }
function number(value: unknown) { const n = Number(value); return Number.isFinite(n) ? n : 0 }
function clampPercent(value: unknown) { return Math.min(100, Math.max(0, number(value))) }
function display(value: unknown, unit = '') {
  if (value === null || value === undefined || value === '') return '—'
  return `${typeof value === 'number' ? Math.round(value * 10) / 10 : value}${unit}`
}
function metricText(item: { value: unknown; unit?: string }) {
  if (item.value === null || item.value === undefined || item.value === '') return '—'
  return `${typeof item.value === 'number' ? Math.round(item.value) : item.value}${item.unit || ''}`
}
function formatDay(value: string) {
  const date = new Date(`${value}T12:00:00`)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(spanish.value ? 'es' : 'en', { weekday: 'short' }).format(date)
}
function weatherCondition(value: string, code?: number) {
  if (spanish.value) return value
  const byCode: Record<number, string> = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Light freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain',
    65: 'Heavy rain', 66: 'Light freezing rain', 67: 'Freezing rain', 71: 'Light snow',
    73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light showers', 81: 'Showers',
    82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm',
    96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
  }
  if (typeof code === 'number' && byCode[code]) return byCode[code]
  const labels: Record<string, string> = {
    Despejado: 'Clear', 'Casi despejado': 'Mostly clear', 'Parcialmente nublado': 'Partly cloudy',
    Cubierto: 'Overcast', Niebla: 'Fog', 'Niebla con escarcha': 'Rime fog',
    'Llovizna ligera': 'Light drizzle', Llovizna: 'Drizzle', 'Llovizna intensa': 'Heavy drizzle',
    'Llovizna helada ligera': 'Light freezing drizzle', 'Llovizna helada': 'Freezing drizzle',
    'Lluvia ligera': 'Light rain', Lluvia: 'Rain', 'Lluvia intensa': 'Heavy rain',
    'Lluvia helada ligera': 'Light freezing rain', 'Lluvia helada': 'Freezing rain',
    'Nieve ligera': 'Light snow', Nieve: 'Snow', 'Nieve intensa': 'Heavy snow',
    'Granizo menudo': 'Snow grains', 'Chubascos ligeros': 'Light showers', Chubascos: 'Showers',
    'Chubascos violentos': 'Heavy showers', 'Chubascos de nieve': 'Snow showers',
    'Chubascos de nieve intensos': 'Heavy snow showers', Tormenta: 'Thunderstorm',
    'Tormenta con granizo': 'Thunderstorm with hail', 'Tormenta fuerte con granizo': 'Severe thunderstorm with hail',
  }
  return labels[value] || value
}
function safeParams(exclude: string[] = []) {
  const omitted = new Set(['token', 'apiKey', 'googleApiKey', ...exclude])
  return Object.fromEntries(Object.entries(parameters.value).filter(([key]) => !omitted.has(key)))
}

function unwrapActionResult(response: any) {
  if (response?.success === false) {
    throw new Error(response.error || (spanish.value ? 'La acción no se pudo completar.' : 'The action could not be completed.'))
  }
  return response?.result ?? response?.data ?? response
}

async function refresh() {
  if (busy.value || !canRefresh.value) return
  busy.value = true
  error.value = ''
  try {
    data.value = unwrapActionResult(
      await executeWidgetAction(props.apiBase, props.action.type, parameters.value),
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : (spanish.value ? 'No se pudo cargar el estado.' : 'Status could not be loaded.')
  } finally {
    loaded.value = true
    busy.value = false
    void nextTick().then(measureLists)
  }
}
async function runAction(type: string, params: Record<string, any> = {}) {
  if (busy.value || props.readonly) return
  busy.value = true
  error.value = ''
  try {
    data.value = unwrapActionResult(await executeWidgetAction(props.apiBase, type, params))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : (spanish.value ? 'No se pudo completar la acción.' : 'Action could not be completed.')
  } finally {
    loaded.value = true
    busy.value = false
  }
}
function openInbox() {
  void runAction(actionType('open-inbox'), { provider: parameters.value.provider, url: parameters.value.inboxUrl })
}
function openChannel(channel: string) {
  void runAction(actionType('open-channel'), { channel })
}
function openDm(user: string) {
  void runAction(actionType('open-dm'), { user })
}
function takeSnapshot() { void runAction(actionType('snapshot'), safeParams()) }
function launchGame() { void runAction(actionType('launch-game'), { appId: parameters.value.appId }) }

onMounted(() => {
  // Commands that would cause a side effect are always explicit.
  if (sideEffectOnly.value) {
    loaded.value = true
    return
  }
  void refresh()
  if (pollMs.value > 0) pollTimer = setInterval(() => void refresh(), pollMs.value)
})
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })
</script>

<style scoped>
.status-cards {
  box-sizing: border-box;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: clamp(8px, 3cqi, 13px);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: clamp(11px, 4cqi, 17px);
  overflow: hidden;
  color: var(--bd-ink, #ece8df);
  background: var(--bd-sf, #191a1d);
  border: 1px solid var(--bd-ln, #34363b);
  border-radius: var(--bd-rk, 14px);
  container-type: size;
  container-name: status-cards;
}
.sc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 20px; flex: none; }
.sc-title { display: inline-flex; align-items: center; gap: 7px; min-width: 0; overflow: hidden; color: var(--bd-mu, #999da5); font-size: 12px; font-weight: 650; }
.sc-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-refresh { display: grid; flex: 0 0 auto; width: 30px; height: 30px; place-items: center; color: var(--bd-mu, #999da5); background: transparent; border: 1px solid transparent; border-radius: 8px; cursor: pointer; }
.sc-refresh:hover:not(:disabled) { color: var(--bd-ink, #ece8df); border-color: var(--bd-ln, #34363b); }
button:focus-visible { outline: 2px solid var(--bd-ac, #e4b85e); outline-offset: 2px; }
button:disabled { opacity: .5; cursor: not-allowed; }
.sc-body { display: flex; flex: 1; flex-direction: column; justify-content: center; gap: 10px; min-height: 0; overflow: hidden; }
.sc-state { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 0; color: var(--bd-mu, #999da5); text-align: center; font-size: 12px; }
.sc-state .err-full { max-width: 100%; overflow-wrap: anywhere; }
/* XS: aviso corto en tono neutro (nada de rojo con texto largo). M+: mensaje completo en danger. */
.sc-err { color: var(--bd-danger, #e56b6f); }
.err-short { display: none; }
.sc-inline-err { display: flex; align-items: center; gap: 6px; margin: 0; overflow: hidden; font-size: 11px; }
.sc-inline-err .err-full { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-retry, .action-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 32px; padding: 0 11px; color: var(--bd-ink, #ece8df); background: transparent; border: 1px solid var(--bd-ln, #34363b); border-radius: 8px; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
.sc-retry:hover:not(:disabled), .action-button:hover:not(:disabled), .sc-iconbtn:hover:not(:disabled) { border-color: var(--bd-ac, #e4b85e); }
.action-button { align-self: flex-start; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
/* Bloques solo-pequeño: ocultos por defecto (jsdom/sin queries = layout completo). */
.xs-only { display: none; }
.xs-carousel, .xs-hero { flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-width: 0; min-height: 0; text-align: center; }
.xs-hero strong, .xs-carousel strong { max-width: 100%; overflow: hidden; font-size: clamp(22px, 22cqi, 44px); line-height: 1.1; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.xs-sub { max-width: 100%; overflow: hidden; color: var(--bd-mu, #999da5); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.xs-line { flex: 1; align-items: center; justify-content: center; min-height: 0; font-size: clamp(12px, 9cqi, 16px); font-weight: 650; }
.xs-status { flex: 1; align-items: center; justify-content: center; gap: 6px; min-height: 0; font-size: clamp(11px, 8cqi, 14px); font-weight: 600; }
.xs-steam { flex: 1; flex-direction: column; align-items: stretch; justify-content: center; gap: 4px; min-height: 0; text-align: left; }
.xs-steam small { color: var(--bd-mu, #999da5); font-size: 11px; }
.xs-action { flex: 1; align-items: center; justify-content: center; gap: 8px; min-height: 0; }
.xs-action .bd-marquee { flex: 1; }
.xs-accent { color: var(--bd-ac, #e4b85e); }
.sc-iconbtn { display: inline-grid; flex: none; place-items: center; width: 38px; height: 38px; color: inherit; background: transparent; border: 1px solid var(--bd-ln, #34363b); border-radius: 10px; cursor: pointer; }
.server-dot { width: 9px; height: 9px; flex: none; background: var(--bd-danger, #e56b6f); border-radius: 50%; }
.server-dot.online { background: var(--bd-ok, #69b982); }
.sc-dots { display: flex; align-items: center; justify-content: center; gap: 6px; flex: none; padding-top: 4px; }
.sc-dot { width: 7px; height: 7px; padding: 0; border: 0; border-radius: 999px; background: currentcolor; opacity: .3; cursor: pointer; }
.list > div, .list > p, .forecast > div, .forecast > p, .metric { flex: none; }
.sc-dot.is-active { width: 16px; opacity: .9; }
.sc-pager { display: flex; align-items: center; justify-content: center; gap: 6px; flex: none; padding-top: 4px; }
.sc-pager small { color: var(--bd-mu, #999da5); font-size: 10px; font-variant-numeric: tabular-nums; }
.metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; flex: 1 1 auto; min-height: 0; overflow: hidden; align-content: start; }
.metric { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-width: 0; padding: 8px; background: color-mix(in srgb, var(--bd-bg, #111214) 55%, transparent); border: 1px solid var(--bd-ln, #34363b); border-radius: 8px; }
.metric span { overflow: hidden; color: var(--bd-mu, #999da5); font-size: 10px; text-overflow: ellipsis; }
.metric b { font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.hero-metric, .network, .latency { display: flex; flex-direction: column; gap: 4px; }
.hero-metric strong, .network strong, .latency strong { font-size: clamp(24px, 12cqi, 42px); line-height: 1; font-variant-numeric: tabular-nums; }
.hero-metric span, .network span, .latency span { color: var(--bd-mu, #999da5); font-size: 11px; }
.list { display: flex; flex: 1 1 auto; flex-direction: column; gap: 5px; min-height: 0; overflow: hidden; }
.list > div, .channel-list button { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; padding: 6px 8px; color: var(--bd-ink, #ece8df); background: color-mix(in srgb, var(--bd-bg, #111214) 55%, transparent); border: 1px solid var(--bd-ln, #34363b); border-radius: 7px; font-size: 11px; text-align: left; }
.list > div span, .channel-list button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.channel-list button { cursor: pointer; }
.channel-list button:hover:not(:disabled) { border-color: var(--bd-ac, #e4b85e); }
.sc-muted, .subheading { margin: 0; color: var(--bd-mu, #999da5); font-size: 11px; }
.sc-muted { display: flex; align-items: center; gap: 9px; line-height: 1.4; }
.sc-muted span { overflow-wrap: anywhere; }
.subheading { overflow: hidden; flex: none; }
.disk { display: flex; flex-direction: column; gap: 8px; }
.disk-label { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.disk-label b { font-size: clamp(24px, 12cqi, 40px); font-variant-numeric: tabular-nums; }
.disk-label span, .disk small { color: var(--bd-mu, #999da5); font-size: 11px; }
.bar { height: 7px; overflow: hidden; background: var(--bd-ln, #34363b); border-radius: 9px; }
.bar i { display: block; height: 100%; background: var(--bd-ac, #e4b85e); border-radius: inherit; }
.network > span { font-variant-numeric: tabular-nums; }
.weather-now { display: flex; align-items: center; gap: 12px; min-width: 0; }
.weather-now > strong { font-size: clamp(30px, 15cqi, 48px); line-height: 1; letter-spacing: -.06em; white-space: nowrap; }
.weather-now > div, .steam-name { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.weather-now b, .steam-name strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.weather-now span, .steam-name span { overflow: hidden; color: var(--bd-mu, #999da5); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.weather-meta { display: flex; gap: 14px; color: var(--bd-mu, #999da5); font-size: 11px; }
.weather-meta span { display: inline-flex; align-items: center; gap: 4px; }
.forecast { display: flex; flex: 1 1 auto; flex-direction: column; gap: 5px; min-height: 0; overflow: hidden; }
.forecast-row { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 6px 0; border-bottom: 1px solid var(--bd-ln, #34363b); font-size: 10px; }
.forecast-row > span:nth-child(2) { overflow: hidden; color: var(--bd-mu, #999da5); text-overflow: ellipsis; white-space: nowrap; }
.forecast-row b { white-space: nowrap; }
.forecast-row small { color: var(--bd-mu, #999da5); font-size: inherit; font-weight: 500; }
.count { display: flex; align-items: baseline; gap: 8px; }
.count strong { font-size: clamp(30px, 16cqi, 52px); line-height: 1; font-variant-numeric: tabular-nums; }
.count span { color: var(--bd-mu, #999da5); font-size: 12px; }
.channel-name { margin: 0; overflow: hidden; font-size: 18px; font-weight: 650; }
.server-state { display: flex; align-items: center; gap: 8px; font-size: 17px; }
.server-state i { width: 9px; height: 9px; background: var(--bd-danger, #e56b6f); border-radius: 50%; }
.server-state.online i { background: var(--bd-ok, #69b982); }
.server-meta { display: flex; justify-content: space-between; gap: 8px; color: var(--bd-mu, #999da5); font-size: 11px; }
.server-meta > span { flex: 1; min-width: 0; overflow: hidden; }
.server-meta b { flex: none; }
.motd { display: block; margin: 0; overflow: hidden; font-size: 11px; }
.unavailable { display: flex; align-items: center; gap: 9px; color: var(--bd-mu, #999da5); font-size: 11px; line-height: 1.4; }
.unavailable span { overflow-wrap: anywhere; }
.description { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.camera-state { display: flex; align-items: center; gap: 10px; color: var(--bd-ac, #e4b85e); font-size: 15px; font-weight: 650; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }

/* XS (< 200px, ≈1×1): solo dato relevante + Marquee/AutoCarousel. Sin
   cabecera, sin refresh, sin acciones secundarias, sin errores rojos. */
@container status-cards (max-width: 199px) {
  .status-cards { padding: 8px; gap: 6px; }
  .xs-only { display: flex; }
  .status-cards .hide-xs { display: none; }
  .status-cards .sc-head { display: none; }
  .sc-err { color: var(--bd-mu, #999da5); }
  .sc-err .err-short { display: inline; }
  .sc-err .err-full { display: none; }
  .sc-dots { display: none; }
}
/* Dots del carrusel solo con altura suficiente (nunca en 1×1 bajo). */
@container status-cards (max-width: 199px) and (min-height: 140px) {
  .sc-dots { display: flex; }
}
/* M (≥ 200px): dato + acción principal; aviso corto oculto. */
@container status-cards (min-width: 200px) {
  .sc-err .err-short { display: none; }
}
/* Refresh manual solo cuando cabe (≥ ~260px). */
@container status-cards (max-width: 259px) {
  .status-cards .sc-refresh { display: none; }
}
/* Baja altura (≤150px, p. ej. filas 2×1/3×1): héroes compactos; las listas
   que no caben rotan por páginas (ver useFitPager), nunca scroll. */
@container status-cards (max-height: 150px) {
  .status-cards { padding: 8px; gap: 6px; }
  .count strong { font-size: clamp(22px, 26cqb, 34px); }
  .hero-metric strong, .network strong, .latency strong, .disk-label b, .weather-now > strong {
    font-size: clamp(20px, 26cqb, 30px);
  }
  .xs-hero strong, .xs-carousel strong { font-size: clamp(18px, 30cqb, 30px); }
  .metrics, .list, .forecast { min-height: 0; overflow: hidden; }
}
/* Blindaje: ningún descendiente puede abrir scrollbar (sin scroll). */
.status-cards *, .status-cards *::before, .status-cards *::after {
  scrollbar-width: none !important;
}
.status-cards *::-webkit-scrollbar { display: none !important; }
/* Muy baja (≤129px): la cabecera cede su sitio al dato + acción. */
@container status-cards (max-height: 129px) {
  .status-cards .sc-head { display: none; }
}
/* Ancha: héroes en fila; alta: todo apilado (defecto columna). */
@container status-cards (min-aspect-ratio: 13/10) {
  .xs-hero, .xs-carousel { flex-direction: row; align-items: baseline; gap: 8px; }
  .xs-hero strong, .xs-carousel strong { font-size: clamp(20px, 14cqi, 36px); }
}
</style>
