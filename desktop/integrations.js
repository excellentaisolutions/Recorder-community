export function bindIntegrations(api, controller) {
  const $ = selector => document.querySelector(selector);
  let config;
  const refresh = async () => {
    try {
      config = await api.integrationStatus();
      $('#agent-enabled').checked = config.enabled;
      $('#agent-connection').textContent = config.enabled ? 'Acceso local activo · clave privada en tu perfil de Windows' : 'Acceso desactivado';
      $('#agent-config').textContent = JSON.stringify(config.mcp, null, 2);
      $('#agent-jobs').textContent = config.jobs.map(job => `${job.owner} · ${job.status}${job.error ? ' · ' + job.error : ''}`).join('\n') || 'Sin tareas de demo o montaje';
      $('#agent-activity').replaceChildren(...config.activity.map(item => {
        const li = document.createElement('li');
        li.textContent = `${new Date(item.at).toLocaleTimeString()} · ${item.client} · ${item.method} · ${item.status}`;
        return li;
      }));
    } catch (error) { $('#agent-connection').textContent = error.message; }
  };
  $('#agent-enabled').addEventListener('change', async event => {
    await api.integrationSet({ enabled: event.target.checked, rotate: false });
    await refresh();
  });
  $('#agent-revoke').addEventListener('click', async () => {
    await api.integrationSet({ enabled: false, rotate: true });
    await refresh();
  });
  $('#agent-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(JSON.stringify(config.mcp, null, 2));
    $('#agent-connection').textContent = 'Configuración MCP copiada';
  });
  $('#agent-stop').addEventListener('click', () => controller.stop().catch(error => { $('#agent-session').textContent = error.message; }));
  $('#agent-cancel-jobs').addEventListener('click', async () => { await api.integrationCancel(); await refresh(); });
  controller.addEventListener('state', () => {
    const status = controller.status();
    $('#agent-session').textContent = status.id ? `${status.owner} · ${status.state} · ${Math.floor(status.elapsed)} s` : 'Sin sesión activa';
    $('#agent-stop').disabled = !['starting', 'recording', 'paused'].includes(status.state);
  });
  api.onIntegrationChanged(refresh);
  refresh();
}
