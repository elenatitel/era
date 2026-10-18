import { Global, Injectable, Logger, Module } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

type Locale = 'ro' | 'en';

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const T = {
  invite: {
    ro: (org: string) => ({
      subject: `Invitație în ${org}`,
      intro: `Ați fost invitat(ă) să vă alăturați organizației ${org}.`,
      cta: 'Acceptă invitația',
      outro: 'Linkul expiră în 7 zile. Dacă nu așteptați acest e-mail, îl puteți ignora.',
    }),
    en: (org: string) => ({
      subject: `Invitation to ${org}`,
      intro: `You have been invited to join ${org}.`,
      cta: 'Accept invitation',
      outro: 'The link expires in 7 days. If you were not expecting this e-mail you can ignore it.',
    }),
  },
  reset: {
    ro: () => ({
      subject: 'Resetare parolă',
      intro: 'Am primit o cerere de resetare a parolei pentru contul dumneavoastră.',
      cta: 'Setează o parolă nouă',
      outro: 'Linkul expiră în 60 de minute. Dacă nu ați solicitat resetarea, ignorați acest e-mail.',
    }),
    en: () => ({
      subject: 'Password reset',
      intro: 'We received a request to reset the password for your account.',
      cta: 'Set a new password',
      outro: 'The link expires in 60 minutes. If you did not request a reset, ignore this e-mail.',
    }),
  },
};

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transporter | null;
  /** Last messages, for tests and local development without SMTP. */
  readonly outbox: { to: string; subject: string; text: string }[] = [];

  constructor() {
    const c = config();
    this.transport = c.SMTP_HOST
      ? nodemailer.createTransport({
          host: c.SMTP_HOST,
          port: c.SMTP_PORT,
          secure: c.SMTP_SECURE,
          auth: c.SMTP_USER ? { user: c.SMTP_USER, pass: c.SMTP_PASSWORD } : undefined,
        })
      : null;
  }

  async sendInvitation(to: string, org: string, token: string, locale: Locale) {
    const link = `${config().WEB_ORIGIN}/invite/${token}`;
    await this.send(to, T.invite[locale](org), link);
  }

  async sendPasswordReset(to: string, token: string, locale: Locale) {
    const link = `${config().WEB_ORIGIN}/reset-password/${token}`;
    await this.send(to, T.reset[locale](), link);
  }

  private async send(to: string, t: { subject: string; intro: string; cta: string; outro: string }, link: string) {
    const app = config().APP_NAME;
    const text = `${t.intro}\n\n${t.cta}: ${link}\n\n${t.outro}\n\n— ${app}`;
    const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#1f2937">
      <h2 style="color:#e8552d">${escape(app)}</h2><p>${escape(t.intro)}</p>
      <p><a href="${escape(link)}" style="display:inline-block;background:#e8552d;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${escape(t.cta)}</a></p>
      <p style="color:#6b7280;font-size:13px">${escape(t.outro)}</p></div>`;
    this.outbox.push({ to, subject: t.subject, text });
    if (this.outbox.length > 50) this.outbox.shift();
    if (!this.transport) {
      if (!config().isProduction) this.logger.log(`[mail disabled] To: ${to} | ${t.subject} | ${link}`);
      else this.logger.warn(`SMTP is not configured; e-mail "${t.subject}" was not sent`);
      return;
    }
    try {
      await this.transport.sendMail({ from: config().MAIL_FROM, to, subject: t.subject, text, html });
    } catch (err) {
      this.logger.error(`Failed to send e-mail "${t.subject}": ${(err as Error).message}`);
    }
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
