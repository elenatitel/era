'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Locale = 'en' | 'ro';

const en = {
  app: { name: 'era.', tagline: 'A new era of hospitality' },
  common: {
    save: 'Save', cancel: 'Cancel', create: 'Create', edit: 'Edit', delete: 'Delete', close: 'Close', search: 'Search',
    loading: 'Loading…', none: 'Nothing here yet', actions: 'Actions', status: 'Status', name: 'Name', email: 'E-mail',
    phone: 'Phone', notes: 'Notes', date: 'Date', from: 'From', to: 'To', total: 'Total', yes: 'Yes', no: 'No',
    back: 'Back', confirm: 'Confirm', print: 'Print', export: 'Export', all: 'All', add: 'Add', code: 'Code',
    description: 'Description', active: 'Active', inactive: 'Inactive', optional: 'optional', saved: 'Saved',
    previous: 'Previous', next: 'Next', page: 'Page', property: 'Property', amount: 'Amount', reason: 'Reason',
    country: 'Country', city: 'City', address: 'Address', type: 'Type', details: 'Details', apply: 'Apply',
  },
  nav: {
    dashboard: 'Dashboard', frontDesk: 'Front Office', reservations: 'Reservations', calendar: 'Calendar',
    housekeeping: 'Housekeeping', guests: 'Guests', companies: 'Companies', invoices: 'Invoices', payments: 'Payments',
    settings: 'Settings', property: 'Property', rooms: 'Rooms', rates: 'Rates', team: 'Team', roles: 'Roles',
    organization: 'Organization', audit: 'Audit log', profile: 'My account', platform: 'Platform', logout: 'Sign out',
    operations: 'Operations', finance: 'Financial', crm: 'Guests & CRM', administration: 'Administration',
    switchOrg: 'Switch organization',
  },
  auth: {
    signIn: 'Sign in', email: 'E-mail', password: 'Password', forgot: 'Forgot password?', welcome: 'Welcome back',
    signInHint: 'Sign in to manage your properties', mfaTitle: 'Two-factor authentication',
    mfaHint: 'Enter the 6-digit code from your authenticator app, or a recovery code.', code: 'Code', verify: 'Verify',
    forgotTitle: 'Reset your password', forgotHint: 'We will e-mail you a link to set a new password.',
    sendLink: 'Send reset link', linkSent: 'If an account exists for this address, a reset link is on its way.',
    newPassword: 'New password', confirmPassword: 'Confirm password', setPassword: 'Set password',
    passwordsDiffer: 'Passwords do not match', passwordReset: 'Password updated. You can sign in now.',
    passwordRules: 'At least 12 characters, mixing letters with digits or symbols.',
    inviteTitle: 'Join {org}', inviteHint: 'You were invited as {email}.', acceptInvite: 'Accept invitation',
    yourName: 'Your name', inviteAccepted: 'Invitation accepted. Sign in to continue.',
    chooseOrg: 'Choose an organization', noOrgs: 'You are not a member of any organization yet.',
    backToLogin: 'Back to sign in',
  },
  dashboard: {
    title: 'Dashboard', businessDate: 'Business date', occupancy: 'Occupancy', inHouse: 'In-house',
    arrivals: 'Arrivals', departures: 'Departures', revenueToday: 'Revenue today', revenueMonth: 'Revenue this month',
    adr: 'ADR', revpar: 'RevPAR', openBalance: 'Open balances', roomStatus: 'Room status', forecast: 'Occupancy forecast (14 days)',
    noProperty: 'Create your first property to get started.', nightAudit: 'Run night audit',
    nightAuditConfirm: 'Close the business day {date}? Room charges will be posted and no-shows marked.',
    nightAuditDone: 'Business day closed. New business date: {date}.',
    greetingMorning: 'Good morning, {name}', greetingAfternoon: 'Good afternoon, {name}', greetingEvening: 'Good evening, {name}',
    summary: '{property} has {arrivals} arrivals, {departures} departures and {inHouse} occupied rooms today.',
    roomsOf: '{n} of {total} rooms', waitingCheckIn: '{n} waiting for check-in', stillToLeave: '{n} still to check out',
    forecastTitle: 'Occupancy forecast', forecastPeak: 'Peak {pct}% on {date}',
    notReady: 'Rooms {rooms} have arrivals today and are not ready yet. Assign a ready room or prioritise cleaning in Housekeeping.',
    openHousekeeping: 'Open housekeeping', hkTasks: 'Cleaning tasks today', hkDetail: '{inProgress} in progress · {unassigned} unassigned',
    arrivalsToday: 'Arrivals today ({n})', departuresToday: 'Departures today ({n})', openFrontDesk: 'Front Office',
    financeTitle: 'Financial · this month', adrLong: 'ADR · average rate per night', revparLong: 'RevPAR · revenue per available room',
    openBalanceLong: 'Open balances (in-house guests)', paymentsToday: 'Payments today', paymentsReport: 'Payments report', noPayments: 'No payments yet today',
    checkedIn: 'Checked in', departed: 'Departed', occupiedRoom: 'Occupied',
  },
  roomStatus: { clean: 'Clean', dirty: 'Dirty', inspected: 'Inspected', out_of_order: 'Out of order', vacant: 'Vacant', occupied: 'Occupied' },
  resStatus: { tentative: 'Tentative', confirmed: 'Confirmed', checked_in: 'In-house', checked_out: 'Checked out', cancelled: 'Cancelled', no_show: 'No-show' },
  sources: { direct: 'Direct', phone: 'Phone', email: 'E-mail', walk_in: 'Walk-in', website: 'Website', ota: 'OTA', agent: 'Agent', corporate: 'Corporate' },
  segments: { standard: 'Standard', vip: 'VIP', business: 'Business', agent: 'Agent' },
  frontDesk: {
    title: 'Front Office', arrivals: 'Arrivals', departures: 'Departures', inHouse: 'In-house', checkIn: 'Check in',
    checkOut: 'Check out', assignRoom: 'Assign room', selectRoom: 'Select a room', allowDirty: 'Allow a room not yet cleaned',
    openBalance: 'Outstanding balance', allowBalance: 'Check out with open balance (bill later)', walkIn: 'Walk-in',
  },
  reservations: {
    title: 'Reservations', new: 'New reservation', code: 'Code', guest: 'Guest', room: 'Room', roomType: 'Room type',
    arrival: 'Arrival', departure: 'Departure', nights: 'Nights', adults: 'Adults', children: 'Children', source: 'Source',
    ratePlan: 'Rate plan', available: 'available', soldOut: 'Sold out', select: 'Select', searchAvailability: 'Check availability',
    guestDetails: 'Guest', existingGuest: 'Existing guest', newGuest: 'New guest', firstName: 'First name', lastName: 'Last name',
    confirm: 'Create reservation', cancel: 'Cancel reservation', noShow: 'Mark no-show', folio: 'Folio', payments: 'Payments',
    postCharge: 'Post charge', addPayment: 'Record payment', balance: 'Balance', charges: 'Charges', paid: 'Paid', void: 'Void',
    voided: 'Void', category: 'Category', quantity: 'Qty', unitPrice: 'Unit price', vat: 'VAT', method: 'Method',
    reference: 'Reference', issueInvoice: 'Issue invoice', issueProforma: 'Issue proforma', company: 'Company',
    searchHint: 'Code, guest name, e-mail…', nightlyRates: 'Nightly rates', breakfast: 'Breakfast included',
    minNights: 'Min. {n} nights', refund: 'Refund', created: 'Reservation {code} created',
  },
  charges: { accommodation: 'Accommodation', food_beverage: 'Food & beverage', minibar: 'Minibar', laundry: 'Laundry', spa: 'Spa', parking: 'Parking', tourist_tax: 'Tourist tax', other: 'Other' },
  methods: { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', voucher: 'Voucher', other: 'Other' },
  calendar: { title: 'Calendar', unassigned: 'Unassigned', today: 'Today' },
  housekeeping: {
    title: 'Housekeeping', board: 'Room board', myTasks: 'My tasks', tasks: 'Tasks', generate: 'Generate today\'s tasks',
    assignTo: 'Assign to', unassigned: 'Unassigned', start: 'Start', done: 'Done', inspect: 'Inspect', markClean: 'Mark clean',
    markDirty: 'Mark dirty', outOfOrder: 'Out of order', backInService: 'Back in service', guest: 'Guest', departing: 'Departing',
    arriving: 'Arriving', noTasks: 'No tasks for today.',
  },
  hkType: { checkout_clean: 'Departure clean', stayover: 'Stay-over', deep_clean: 'Deep clean', inspection: 'Inspection', turndown: 'Turndown' },
  hkStatus: { pending: 'Pending', in_progress: 'In progress', done: 'Done', inspected: 'Inspected', cancelled: 'Cancelled' },
  guests: {
    title: 'Guests', new: 'New guest', segment: 'Segment', stays: 'Stays', nationality: 'Nationality', document: 'ID document',
    documentType: 'Document type', documentNumber: 'Document number', birthDate: 'Birth date', tags: 'Tags',
    marketing: 'Marketing consent', history: 'Stay history', lifetimeValue: 'Lifetime value', gdprExport: 'GDPR export',
    anonymize: 'Anonymize', anonymizeConfirm: 'Permanently erase this guest\'s personal data? Financial records are kept.',
  },
  docTypes: { id_card: 'ID card', passport: 'Passport', driving_license: 'Driving license', other: 'Other' },
  companies: { title: 'Companies & agencies', new: 'New company', taxId: 'Tax ID (CUI)', regNo: 'Trade register no.', agency: 'Travel agency', commission: 'Commission %' },
  invoices: {
    title: 'Invoices', number: 'Number', issueDate: 'Issue date', dueDate: 'Due date', billTo: 'Bill to', seller: 'Seller',
    subtotal: 'Subtotal', vat: 'VAT', total: 'Total', cancel: 'Cancel (credit note)', invoice: 'Invoice', proforma: 'Proforma',
    credit_note: 'Credit note', issued: 'Issued', paid: 'Paid', cancelled: 'Cancelled', new: 'New invoice',
    net: 'Net', registerPayment: 'Register payment', vatRate: 'VAT rate',
  },
  paymentsReport: { title: 'Payments', byMethod: 'By method' },
  settings: {
    propertyTitle: 'Properties', newProperty: 'New property', legalName: 'Legal name', taxId: 'Tax ID', regNo: 'Registration no.',
    timezone: 'Time zone', currency: 'Currency', checkIn: 'Check-in time', checkOut: 'Check-out time',
    accommodationVat: 'Accommodation VAT (%)', standardVat: 'Standard VAT (%)', invoicePrefix: 'Invoice series', proformaPrefix: 'Proforma series',
    roomTypes: 'Room types', newRoomType: 'New room type', baseOccupancy: 'Base occupancy', maxOccupancy: 'Max occupancy',
    baseRate: 'Base rate / night', rooms: 'Rooms', newRoom: 'New room', number: 'Number', floor: 'Floor',
    ratePlans: 'Rate plans', newRatePlan: 'New rate plan', adjustment: 'Adjustment vs base (%)', minNights: 'Minimum nights',
    breakfast: 'Includes breakfast', dynamicRates: 'Dynamic pricing', price: 'Price', closed: 'Stop sell', weekdays: 'Weekdays',
    applyRates: 'Apply to range', allPlans: 'All rate plans',
    team: 'Team', invite: 'Invite member', role: 'Role', properties: 'Properties', allProperties: 'All properties',
    pendingInvites: 'Pending invitations', lastLogin: 'Last sign-in', disable: 'Disable', enable: 'Enable', remove: 'Remove',
    roles: 'Roles', newRole: 'New role', permissions: 'Permissions', system: 'System', members: 'members',
    organization: 'Organization', requireMfa: 'Require two-factor authentication for all members', defaultLocale: 'Default language',
    audit: 'Audit log', user: 'User', action: 'Action', entity: 'Entity', ip: 'IP',
  },
  profile: {
    title: 'My account', language: 'Language', changePassword: 'Change password', currentPassword: 'Current password',
    mfa: 'Two-factor authentication', mfaOn: 'Enabled', mfaOff: 'Not enabled', enableMfa: 'Enable 2FA', disableMfa: 'Disable 2FA',
    scanQr: 'Scan this QR code with Google Authenticator, Microsoft Authenticator, 1Password or similar, then enter the code.',
    recoveryCodes: 'Recovery codes', recoveryHint: 'Store these codes safely. Each can be used once if you lose your device.',
    recoveryLeft: '{n} recovery codes left', logoutAll: 'Sign out of all devices', mfaRequiredBanner: 'Your organization requires two-factor authentication. Enable it to continue.',
  },
  platform: {
    title: 'Organizations', newTenant: 'New organization', slug: 'Slug', ownerEmail: 'Owner e-mail', ownerName: 'Owner name',
    suspend: 'Suspend', activate: 'Activate', sessions: 'Active sessions', created: 'Organization created — the owner received an invitation.',
  },
  perm: {
    administration: 'Administration', property: 'Property', frontOffice: 'Front office', financial: 'Financial',
    housekeeping: 'Housekeeping', guests: 'Guests & CRM',
  },
  errors: { generic: 'Something went wrong. Please try again.', forbidden: 'You do not have access to this page.', notFound: 'Not found' },
};

type Dict = typeof en;
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : string };

const ro: DeepPartial<Dict> = {
  app: { tagline: 'O nouă eră a ospitalității' },
  common: {
    save: 'Salvează', cancel: 'Anulează', create: 'Creează', edit: 'Editează', delete: 'Șterge', close: 'Închide', search: 'Caută',
    loading: 'Se încarcă…', none: 'Nimic aici încă', actions: 'Acțiuni', status: 'Stare', name: 'Nume', email: 'E-mail',
    phone: 'Telefon', notes: 'Observații', date: 'Data', from: 'De la', to: 'Până la', total: 'Total', yes: 'Da', no: 'Nu',
    back: 'Înapoi', confirm: 'Confirmă', print: 'Tipărește', export: 'Exportă', all: 'Toate', add: 'Adaugă', code: 'Cod',
    description: 'Descriere', active: 'Activ', inactive: 'Inactiv', optional: 'opțional', saved: 'Salvat',
    previous: 'Anterior', next: 'Următor', page: 'Pagina', property: 'Proprietate', amount: 'Sumă', reason: 'Motiv',
    country: 'Țară', city: 'Oraș', address: 'Adresă', type: 'Tip', details: 'Detalii', apply: 'Aplică',
  },
  nav: {
    dashboard: 'Panou', frontDesk: 'Front Office', reservations: 'Rezervări', calendar: 'Calendar',
    housekeeping: 'Housekeeping', guests: 'Clienți', companies: 'Companii', invoices: 'Facturi', payments: 'Încasări',
    settings: 'Setări', property: 'Proprietate', rooms: 'Camere', rates: 'Tarife', team: 'Echipă', roles: 'Roluri',
    organization: 'Organizație', audit: 'Jurnal audit', profile: 'Contul meu', platform: 'Platformă', logout: 'Deconectare',
    operations: 'Operațiuni', finance: 'Financiar', crm: 'Clienți & CRM', administration: 'Administrare',
    switchOrg: 'Schimbă organizația',
  },
  auth: {
    signIn: 'Autentificare', email: 'E-mail', password: 'Parolă', forgot: 'Ați uitat parola?', welcome: 'Bine ați revenit',
    signInHint: 'Autentificați-vă pentru a vă administra proprietățile', mfaTitle: 'Autentificare în doi pași',
    mfaHint: 'Introduceți codul de 6 cifre din aplicația de autentificare sau un cod de recuperare.', code: 'Cod', verify: 'Verifică',
    forgotTitle: 'Resetați parola', forgotHint: 'Vă trimitem pe e-mail un link pentru a seta o parolă nouă.',
    sendLink: 'Trimite linkul', linkSent: 'Dacă există un cont pentru această adresă, linkul de resetare a fost trimis.',
    newPassword: 'Parolă nouă', confirmPassword: 'Confirmă parola', setPassword: 'Setează parola',
    passwordsDiffer: 'Parolele nu coincid', passwordReset: 'Parola a fost actualizată. Vă puteți autentifica.',
    passwordRules: 'Minim 12 caractere, litere combinate cu cifre sau simboluri.',
    inviteTitle: 'Alăturați-vă {org}', inviteHint: 'Ați fost invitat(ă) ca {email}.', acceptInvite: 'Acceptă invitația',
    yourName: 'Numele dumneavoastră', inviteAccepted: 'Invitație acceptată. Autentificați-vă pentru a continua.',
    chooseOrg: 'Alegeți organizația', noOrgs: 'Nu sunteți încă membru al vreunei organizații.',
    backToLogin: 'Înapoi la autentificare',
  },
  dashboard: {
    title: 'Panou de control', businessDate: 'Zi hotelieră', occupancy: 'Grad de ocupare', inHouse: 'Cazați',
    arrivals: 'Sosiri', departures: 'Plecări', revenueToday: 'Venituri azi', revenueMonth: 'Venituri luna curentă',
    adr: 'ADR', revpar: 'RevPAR', openBalance: 'Solduri deschise', roomStatus: 'Starea camerelor', forecast: 'Prognoză ocupare (14 zile)',
    noProperty: 'Creați prima proprietate pentru a începe.', nightAudit: 'Închidere de zi',
    nightAuditConfirm: 'Închideți ziua hotelieră {date}? Se vor posta tarifele de cazare și se vor marca neprezentările.',
    nightAuditDone: 'Zi închisă. Noua zi hotelieră: {date}.',
    greetingMorning: 'Bună dimineața, {name}', greetingAfternoon: 'Bună ziua, {name}', greetingEvening: 'Bună seara, {name}',
    summary: '{property} are azi {arrivals} sosiri, {departures} plecări și {inHouse} camere ocupate.',
    roomsOf: '{n} din {total} camere', waitingCheckIn: '{n} așteaptă check-in', stillToLeave: '{n} încă de plecat',
    forecastTitle: 'Ocupare prognozată', forecastPeak: 'Vârf {pct}% pe {date}',
    notReady: 'Camerele {rooms} au sosiri azi și nu sunt încă pregătite. Alocă o cameră pregătită sau prioritizează curățenia în Housekeeping.',
    openHousekeeping: 'Deschide housekeeping', hkTasks: 'Sarcini de curățenie azi', hkDetail: '{inProgress} în lucru · {unassigned} nealocate',
    arrivalsToday: 'Sosiri azi ({n})', departuresToday: 'Plecări azi ({n})', openFrontDesk: 'Front Office',
    financeTitle: 'Financiar · luna curentă', adrLong: 'ADR · tarif mediu pe noapte', revparLong: 'RevPAR · venit pe cameră disponibilă',
    openBalanceLong: 'Solduri deschise (oaspeți cazați)', paymentsToday: 'Încasări azi', paymentsReport: 'Raport încasări', noPayments: 'Nicio încasare azi',
    checkedIn: 'Cazat', departed: 'Plecat', occupiedRoom: 'Ocupată',
  },
  roomStatus: { clean: 'Curată', dirty: 'Murdară', inspected: 'Verificată', out_of_order: 'Indisponibilă', vacant: 'Liberă', occupied: 'Ocupată' },
  resStatus: { tentative: 'Opțională', confirmed: 'Confirmată', checked_in: 'Cazat', checked_out: 'Plecat', cancelled: 'Anulată', no_show: 'Neprezentare' },
  sources: { direct: 'Direct', phone: 'Telefon', email: 'E-mail', walk_in: 'Walk-in', website: 'Website', ota: 'OTA', agent: 'Agenție', corporate: 'Corporate' },
  segments: { standard: 'Standard', vip: 'VIP', business: 'Business', agent: 'Agenție' },
  frontDesk: {
    title: 'Front Office', arrivals: 'Sosiri', departures: 'Plecări', inHouse: 'Cazați', checkIn: 'Check-in',
    checkOut: 'Check-out', assignRoom: 'Alocă camera', selectRoom: 'Selectați camera', allowDirty: 'Permite o cameră necurățată',
    openBalance: 'Sold restant', allowBalance: 'Check-out cu sold deschis (facturare ulterioară)', walkIn: 'Walk-in',
  },
  reservations: {
    title: 'Rezervări', new: 'Rezervare nouă', code: 'Cod', guest: 'Client', room: 'Camera', roomType: 'Tip cameră',
    arrival: 'Sosire', departure: 'Plecare', nights: 'Nopți', adults: 'Adulți', children: 'Copii', source: 'Sursă',
    ratePlan: 'Plan tarifar', available: 'disponibile', soldOut: 'Indisponibil', select: 'Alege', searchAvailability: 'Verifică disponibilitatea',
    guestDetails: 'Client', existingGuest: 'Client existent', newGuest: 'Client nou', firstName: 'Prenume', lastName: 'Nume',
    confirm: 'Creează rezervarea', cancel: 'Anulează rezervarea', noShow: 'Marchează neprezentare', folio: 'Folio', payments: 'Plăți',
    postCharge: 'Adaugă consum', addPayment: 'Înregistrează plata', balance: 'Sold', charges: 'Consumuri', paid: 'Plătit', void: 'Anulează',
    voided: 'Anulat', category: 'Categorie', quantity: 'Cant.', unitPrice: 'Preț unitar', vat: 'TVA', method: 'Metodă',
    reference: 'Referință', issueInvoice: 'Emite factură', issueProforma: 'Emite proformă', company: 'Companie',
    searchHint: 'Cod, nume client, e-mail…', nightlyRates: 'Tarife pe noapte', breakfast: 'Mic dejun inclus',
    minNights: 'Min. {n} nopți', refund: 'Rambursare', created: 'Rezervarea {code} a fost creată',
  },
  charges: { accommodation: 'Cazare', food_beverage: 'Restaurant & bar', minibar: 'Minibar', laundry: 'Spălătorie', spa: 'Spa', parking: 'Parcare', tourist_tax: 'Taxă de stațiune', other: 'Altele' },
  methods: { cash: 'Numerar', card: 'Card', bank_transfer: 'Transfer bancar', voucher: 'Voucher', other: 'Altele' },
  calendar: { title: 'Calendar', unassigned: 'Nealocate', today: 'Azi' },
  housekeeping: {
    title: 'Housekeeping', board: 'Starea camerelor', myTasks: 'Sarcinile mele', tasks: 'Sarcini', generate: 'Generează sarcinile zilei',
    assignTo: 'Alocă', unassigned: 'Nealocată', start: 'Începe', done: 'Gata', inspect: 'Verifică', markClean: 'Marchează curată',
    markDirty: 'Marchează murdară', outOfOrder: 'Indisponibilă', backInService: 'Repune în uz', guest: 'Client', departing: 'Pleacă',
    arriving: 'Sosește', noTasks: 'Nicio sarcină pentru azi.',
  },
  hkType: { checkout_clean: 'Curățenie la plecare', stayover: 'Curățenie zilnică', deep_clean: 'Curățenie generală', inspection: 'Verificare', turndown: 'Pregătire seară' },
  hkStatus: { pending: 'De făcut', in_progress: 'În lucru', done: 'Finalizată', inspected: 'Verificată', cancelled: 'Anulată' },
  guests: {
    title: 'Clienți', new: 'Client nou', segment: 'Segment', stays: 'Sejururi', nationality: 'Naționalitate', document: 'Act de identitate',
    documentType: 'Tip document', documentNumber: 'Număr document', birthDate: 'Data nașterii', tags: 'Etichete',
    marketing: 'Acord marketing', history: 'Istoric sejururi', lifetimeValue: 'Valoare totală', gdprExport: 'Export GDPR',
    anonymize: 'Anonimizează', anonymizeConfirm: 'Ștergeți definitiv datele personale ale clientului? Înregistrările financiare se păstrează.',
  },
  docTypes: { id_card: 'Carte de identitate', passport: 'Pașaport', driving_license: 'Permis de conducere', other: 'Altul' },
  companies: { title: 'Companii & agenții', new: 'Companie nouă', taxId: 'CUI', regNo: 'Nr. Reg. Com.', agency: 'Agenție de turism', commission: 'Comision %' },
  invoices: {
    title: 'Facturi', number: 'Număr', issueDate: 'Data emiterii', dueDate: 'Scadență', billTo: 'Cumpărător', seller: 'Furnizor',
    subtotal: 'Valoare fără TVA', vat: 'TVA', total: 'Total de plată', cancel: 'Stornează', invoice: 'Factură', proforma: 'Proformă',
    credit_note: 'Factură storno', issued: 'Emisă', paid: 'Achitată', cancelled: 'Stornată', new: 'Factură nouă',
    net: 'Valoare', registerPayment: 'Înregistrează încasarea', vatRate: 'Cota TVA',
  },
  paymentsReport: { title: 'Încasări', byMethod: 'Pe metode' },
  settings: {
    propertyTitle: 'Proprietăți', newProperty: 'Proprietate nouă', legalName: 'Denumire firmă', taxId: 'CUI', regNo: 'Nr. Reg. Com.',
    timezone: 'Fus orar', currency: 'Monedă', checkIn: 'Ora check-in', checkOut: 'Ora check-out',
    accommodationVat: 'TVA cazare (%)', standardVat: 'TVA standard (%)', invoicePrefix: 'Serie facturi', proformaPrefix: 'Serie proforme',
    roomTypes: 'Tipuri de camere', newRoomType: 'Tip nou de cameră', baseOccupancy: 'Ocupare standard', maxOccupancy: 'Ocupare maximă',
    baseRate: 'Tarif de bază / noapte', rooms: 'Camere', newRoom: 'Cameră nouă', number: 'Număr', floor: 'Etaj',
    ratePlans: 'Planuri tarifare', newRatePlan: 'Plan tarifar nou', adjustment: 'Ajustare față de bază (%)', minNights: 'Nopți minime',
    breakfast: 'Include mic dejun', dynamicRates: 'Tarife dinamice', price: 'Preț', closed: 'Oprire vânzare', weekdays: 'Zilele săptămânii',
    applyRates: 'Aplică pe interval', allPlans: 'Toate planurile tarifare',
    team: 'Echipă', invite: 'Invită membru', role: 'Rol', properties: 'Proprietăți', allProperties: 'Toate proprietățile',
    pendingInvites: 'Invitații în așteptare', lastLogin: 'Ultima autentificare', disable: 'Dezactivează', enable: 'Activează', remove: 'Elimină',
    roles: 'Roluri', newRole: 'Rol nou', permissions: 'Permisiuni', system: 'Sistem', members: 'membri',
    organization: 'Organizație', requireMfa: 'Autentificare în doi pași obligatorie pentru toți membrii', defaultLocale: 'Limba implicită',
    audit: 'Jurnal de audit', user: 'Utilizator', action: 'Acțiune', entity: 'Entitate', ip: 'IP',
  },
  profile: {
    title: 'Contul meu', language: 'Limbă', changePassword: 'Schimbă parola', currentPassword: 'Parola curentă',
    mfa: 'Autentificare în doi pași', mfaOn: 'Activată', mfaOff: 'Neactivată', enableMfa: 'Activează 2FA', disableMfa: 'Dezactivează 2FA',
    scanQr: 'Scanați codul QR cu Google Authenticator, Microsoft Authenticator, 1Password sau similar, apoi introduceți codul.',
    recoveryCodes: 'Coduri de recuperare', recoveryHint: 'Păstrați aceste coduri în siguranță. Fiecare poate fi folosit o singură dată.',
    recoveryLeft: '{n} coduri de recuperare rămase', logoutAll: 'Deconectare de pe toate dispozitivele', mfaRequiredBanner: 'Organizația dumneavoastră cere autentificare în doi pași. Activați-o pentru a continua.',
  },
  platform: {
    title: 'Organizații', newTenant: 'Organizație nouă', slug: 'Identificator', ownerEmail: 'E-mail proprietar', ownerName: 'Nume proprietar',
    suspend: 'Suspendă', activate: 'Activează', sessions: 'Sesiuni active', created: 'Organizație creată — proprietarul a primit invitația.',
  },
  perm: {
    administration: 'Administrare', property: 'Proprietate', frontOffice: 'Front office', financial: 'Financiar',
    housekeeping: 'Housekeeping', guests: 'Clienți & CRM',
  },
  errors: { generic: 'A apărut o eroare. Încercați din nou.', forbidden: 'Nu aveți acces la această pagină.', notFound: 'Nu a fost găsit' },
};

const dictionaries: Record<Locale, DeepPartial<Dict>> = { en, ro };

function lookup(dict: unknown, path: string): string | undefined {
  let cur: unknown = dict;
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object' && part in cur) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

type I18n = { locale: Locale; setLocale: (l: Locale) => void; t: (key: string, vars?: Record<string, string | number>) => string };
const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('pms_locale');
      if (saved === 'en' || saved === 'ro') setLocaleState(saved);
    } catch {}
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem('pms_locale', l);
    } catch {}
  }, []);
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let s = lookup(dictionaries[locale], key) ?? lookup(en, key) ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    },
    [locale],
  );
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const c = useContext(Ctx);
  if (!c) throw new Error('I18nProvider missing');
  return c;
}
