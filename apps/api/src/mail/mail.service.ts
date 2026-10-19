import { Global, Injectable, Logger, Module } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

type Locale = 'en' | 'ro';

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
    // era. brand: navy ink on white, display serif wordmark with the accent dot (e-mail safe fonts).
    const html = `<div style="background:#f6f7fa;padding:32px 16px;font-family:Figtree,'Segoe UI',Arial,sans-serif;color:#1b2438">
      <div style="max-width:520px;margin:auto;background:#ffffff;border:1px solid #e6e6e6;border-radius:16px;overflow:hidden">
        <div style="background:#2c3a5a;padding:24px 32px">
          <span style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-style:italic;font-size:34px;line-height:34px;color:#ffffff">${escape(app.replace(/\.$/, ''))}</span><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#8fa5d8;margin-left:2px"></span>
          <div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#c7d1ea;margin-top:4px">A new era of hospitality</div>
        </div>
        <div style="padding:28px 32px">
          <p style="margin:0 0 20px;font-size:15px;line-height:22px">${escape(t.intro)}</p>
          <p style="margin:0 0 24px"><a href="${escape(link)}" style="display:inline-block;background:#2c3a5a;color:#ffffff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">${escape(t.cta)}</a></p>
          <p style="margin:0;color:#55607a;font-size:13px;line-height:19px">${escape(t.outro)}</p>
        </div>
      </div>
    </div>`;
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
