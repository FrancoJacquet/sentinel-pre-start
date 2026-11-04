import { createApp } from 'vue';
import '@fontsource/barlow-semi-condensed/400.css';
import '@fontsource/barlow-semi-condensed/600.css';
import '@fontsource/barlow-condensed/600.css';
import './styles.css';
import App from './App.vue';

// ?check=overlay: vista interna de prueba del overlay (fuera del video). Se
// carga aparte para que no entre en el bundle de la demo.
if (new URLSearchParams(location.search).get('check') === 'overlay') {
  import('./components/OverlayCheck.vue').then((m) => createApp(m.default).mount('#app'));
} else {
  createApp(App).mount('#app');
}
