'use strict';

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

const ALERT_COOLDOWN_SEC = parseInt(process.env.ALERT_COOLDOWN_SEC || '60');

class AlertService extends EventEmitter {
  constructor(db) {
    super();
    this._db = db;
    this._cooldownMap = new Map();
    this._mailer = null;
    this._initMailer();
  }

  async createAlert(event) {
    const { cameraId, objectId, zoneId, dwellTime, timestamp } = event;

    const cooldownKey = `${cameraId}:${zoneId || 'global'}`;
    const lastAlert   = this._cooldownMap.get(cooldownKey) || 0;
    const nowMs       = timestamp || Date.now();

    if (nowMs - lastAlert < ALERT_COOLDOWN_SEC * 1000) {
      return null;
    }
    this._cooldownMap.set(cooldownKey, nowMs);

    let eventId = event.eventId;
    if (!eventId) {
      eventId = uuidv4();
      this._db.insert('events', {
        id:        eventId,
        cameraId,
        objectId,
        zoneId:    zoneId || null,
        startTime: new Date(nowMs).toISOString(),
        dwellTime: dwellTime || 0,
      });
    }

    const alertId = uuidv4();
    const alertRow = {
      id:           alertId,
      eventId,
      cameraId,
      objectId,
      dwellTime:    dwellTime || 0,
      timestamp:    new Date(nowMs).toISOString(),
      acknowledged: false,
    };

    this._db.insert('alerts', alertRow);

    const alert = { ...alertRow };
    this.emit('alert', alert);

    const alertData = { ...alert, zoneId, bbox: event.bbox };
    Promise.all([
      this.sendWebhook(alertData).catch(() => {}),
      this.sendEmail(alertData).catch(() => {}),
    ]);

    return alert;
  }

  async sendWebhook(alertData) {
    const url = process.env.ALERT_WEBHOOK_URL;
    if (!url) return;

    const response = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type:      'loitering_alert',
        timestamp: alertData.timestamp,
        cameraId:  alertData.cameraId,
        objectId:  alertData.objectId,
        zoneId:    alertData.zoneId,
        dwellTime: alertData.dwellTime,
        bbox:      alertData.bbox,
        alertId:   alertData.id,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error(`Webhook responded with ${response.status}`);
  }

  async sendEmail(alertData) {
    const to = process.env.ALERT_EMAIL_TO;
    if (!to || !this._mailer) return;

    await this._mailer.sendMail({
      from:    process.env.SMTP_USER || 'lts-alerts@localhost',
      to,
      subject: `[LTS Alert] Loitering detected – Camera ${alertData.cameraId}`,
      html: `
        <h2>Loitering Detection Alert</h2>
        <table>
          <tr><th>Camera ID</th><td>${alertData.cameraId}</td></tr>
          <tr><th>Object ID</th><td>${alertData.objectId}</td></tr>
          <tr><th>Zone ID</th><td>${alertData.zoneId || 'N/A'}</td></tr>
          <tr><th>Dwell Time</th><td>${alertData.dwellTime.toFixed(1)} seconds</td></tr>
          <tr><th>Timestamp</th><td>${alertData.timestamp}</td></tr>
          <tr><th>Alert ID</th><td>${alertData.id}</td></tr>
        </table>
      `,
    });
  }

  acknowledgeAlert(id) {
    const alert = this._db.findOne('alerts', { id });
    if (!alert) return false;
    this._db.update('alerts', id, { acknowledged: true });
    return true;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _initMailer() {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user) return;

    this._mailer = nodemailer.createTransport({
      host,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth:   { user, pass },
    });
  }
}

module.exports = AlertService;
