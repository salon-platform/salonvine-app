/* The outreach email, as sent by outreach-send.js.

   Edit the copy HERE, commit, and the next daily batch picks it up. Two
   placeholders are filled per recipient at send time:
     {{UNSUB}}    a signed one-click unsubscribe link for that address
     {{ADDRESS}}  the mailing address from the outreach settings (required
                  on commercial email in the US)

   Images are hosted on salonvine.com (studio-book-platform repo). The plain
   text twin below is sent alongside so the mail reads fine with images off. */

export const SUBJECT_DEFAULT = 'Everything your salon needs to take bookings, from $19 a month';

export const HTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;padding:0;background-color:#F6F4F0;">
  <tr>
    <td align="center" style="padding:32px 12px;">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;border:1px solid #E5E1DA;border-radius:6px;">

        <!-- Logo -->
        <tr>
          <td align="center" style="padding:36px 40px 8px 40px;">
            <img src="https://salonvine.com/logo-sv.png" width="150" alt="SalonVine" style="display:block;width:150px;max-width:150px;height:auto;border:0;outline:none;text-decoration:none;">
          </td>
        </tr>

        <!-- Headline -->
        <tr>
          <td style="padding:22px 40px 0 40px;font-family:Georgia,'Times New Roman',serif;font-size:25px;line-height:34px;color:#1C1C1A;font-weight:normal;">
            Everything your salon needs to take bookings, from $19 a month.
          </td>
        </tr>

        <tr>
          <td style="padding:20px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#3A3A36;">
            Hello,
          </td>
        </tr>

        <tr>
          <td style="padding:14px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#3A3A36;">
            SalonVine gives your salon its own website, an online calendar your clients can book into at any hour, and a checkout that takes cards right at the chair. You are never billed by the stylist &mdash; each plan covers a team, and you only move up when you outgrow the one you are on.
          </td>
        </tr>

        <tr>
          <td style="padding:14px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#3A3A36;">
            Here is what your salon&rsquo;s page would look like.
          </td>
        </tr>

        <!-- Screenshot: salon site -->
        <tr>
          <td align="center" style="padding:22px 40px 0 40px;">
            <img src="https://salonvine.com/sv-site-hero.jpg" width="520" alt="A SalonVine salon website: the salon's name, a photo of the shop, and a Book an Appointment button." style="display:block;width:520px;max-width:100%;height:auto;border:1px solid #E5E1DA;border-radius:4px;">
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:10px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A857B;">
            Your own website, at your own address. Clients book from their phone at 11pm.
          </td>
        </tr>

        <!-- Screenshot: services menu -->
        <tr>
          <td align="center" style="padding:22px 40px 0 40px;">
            <img src="https://salonvine.com/sv-site-menu.jpg" width="520" alt="The services and pricing page: categories for haircuts, colour, nails and lashes, with a price and a time beside each service." style="display:block;width:520px;max-width:100%;height:auto;border:1px solid #E5E1DA;border-radius:4px;">
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:10px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#8A857B;">
            Your menu, your prices &mdash; and every stylist sets her own timing.
          </td>
        </tr>

        <!-- Why we built it -->
        <tr>
          <td style="padding:34px 40px 0 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
              <tr>
                <td style="padding:4px 0 4px 20px;border-left:3px solid #C9BFA8;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#3A3A36;">
                  <span style="display:block;font-family:Georgia,'Times New Roman',serif;font-size:18px;line-height:26px;color:#1C1C1A;padding-bottom:10px;">Why we built it</span>
                  My wife and I own a salon in mid-Michigan, so this started as our own problem. We ran the shop on the big-name booking systems for years, and two things never sat right: the bill went up every time somebody new took a chair, and every time a client paid us, someone took a slice on the way through.
                  <br><br>
                  So my business partner and I built what we actually wanted. He writes the software, I use it in my salon every day, and when something is clumsy at the chair it gets fixed that week.
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Price comparison -->
        <tr>
          <td style="padding:32px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#3A3A36;">
            That second part is where most of the money goes. Here is what five people on the books costs each month:
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 0 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
              <tr>
                <td style="padding:12px 14px;background-color:#F0F5F2;border-left:3px solid #2E6B52;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#1C1C1A;font-weight:bold;">
                  SalonVine &mdash; Studio Pro <span style="font-weight:normal;color:#6B675F;">(team of 10)</span>
                </td>
                <td align="right" style="padding:12px 14px;background-color:#F0F5F2;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#2E6B52;font-weight:bold;white-space:nowrap;">
                  $39
                </td>
              </tr>
              <tr>
                <td style="padding:11px 14px;border-bottom:1px solid #EDEAE4;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#3A3A36;">Square Appointments Plus</td>
                <td align="right" style="padding:11px 14px;border-bottom:1px solid #EDEAE4;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#3A3A36;white-space:nowrap;">$49</td>
              </tr>
              <tr>
                <td style="padding:11px 14px;border-bottom:1px solid #EDEAE4;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#3A3A36;">GlossGenius Gold</td>
                <td align="right" style="padding:11px 14px;border-bottom:1px solid #EDEAE4;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#3A3A36;white-space:nowrap;">$56</td>
              </tr>
              <tr>
                <td style="padding:11px 14px;border-bottom:1px solid #EDEAE4;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#3A3A36;">Vagaro <span style="color:#8A857B;">($30 + $10 a calendar)</span></td>
                <td align="right" style="padding:11px 14px;border-bottom:1px solid #EDEAE4;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#3A3A36;white-space:nowrap;">$70</td>
              </tr>
              <tr>
                <td style="padding:11px 14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#3A3A36;">Booksy Biz <span style="color:#8A857B;">($29.99 + $20 a stylist)</span></td>
                <td align="right" style="padding:11px 14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#3A3A36;white-space:nowrap;">$109.99</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#8A857B;">
            Everyone&rsquo;s published month-to-month rates, September 2026. A few are cheaper if you pay a year up front.
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#3A3A36;">
            Our three plans: <strong style="color:#1C1C1A;">Studio $19</strong> for a team of three,
            <strong style="color:#1C1C1A;">Studio Pro $39</strong> for a team of ten, and
            <strong style="color:#1C1C1A;">Studio Elite $59</strong> with no limit at all.
            Move between them whenever you like.
          </td>
        </tr>

        <!-- Differentiators -->
        <tr>
          <td style="padding:30px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#3A3A36;">
            Three things I&rsquo;d want to know if I were you:
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 0 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#3A3A36;">
                  <strong style="color:#1C1C1A;">Nobody bills you by the chair.</strong> Studio Pro covers ten people for $39. Hire your fourth stylist, or your ninth, and the invoice looks exactly the same as it did the month before.
                </td>
              </tr>
              <tr>
                <td style="padding:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#3A3A36;">
                  <strong style="color:#1C1C1A;">We never touch your money.</strong> Deposits and checkouts go straight into your own Stripe account. We don&rsquo;t take a percentage of your bookings and we don&rsquo;t take a cut of your sales. Not now, not later.
                </td>
              </tr>
              <tr>
                <td style="padding:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#3A3A36;">
                  <strong style="color:#1C1C1A;">Booth renters keep their own books.</strong> A chair renter can hook up her own Stripe and take her own payments, while your commission girls run through yours. We needed that ourselves, and nothing else did it properly.
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Setup / trial -->
        <tr>
          <td style="padding:28px 40px 0 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FAF8F4;border:1px solid #EDEAE4;border-radius:4px;">
              <tr>
                <td style="padding:20px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#3A3A36;">
                  <strong style="color:#1C1C1A;">It takes about ten minutes to set up.</strong> Salon name, your services, your team &mdash; and your site is live. If you&rsquo;re already on something else, send us your client list and your calendar and we&rsquo;ll move it over for you. You don&rsquo;t have to retype a thing.
                  <br><br>
                  <strong style="color:#1C1C1A;">The first 30 days are free.</strong> No setup fee, no contract, and nobody to argue with on the phone if you want out. Cancel before day 31 and you&rsquo;re never charged a cent.
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td align="center" style="padding:30px 40px 6px 40px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#2E6B52" style="border-radius:4px;">
                  <a href="https://salonvine.com" style="display:inline-block;padding:15px 38px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:20px;color:#FFFFFF;text-decoration:none;font-weight:bold;border-radius:4px;">Try it free for 30 days</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Sign-off -->
        <tr>
          <td style="padding:28px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#3A3A36;">
            Or just hit reply and tell me what you&rsquo;re using now &mdash; I&rsquo;m happy to tell you straight whether we&rsquo;d actually be an upgrade for you. Some salons are better off where they are, and I&rsquo;ll say so.
          </td>
        </tr>
        <tr>
          <td style="padding:22px 40px 36px 40px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#3A3A36;">
            Dylan Haller<br>
            <span style="color:#6B675F;">Co-founder, SalonVine &mdash; and a salon owner, same as you</span><br>
            <a href="mailto:hello@salonvine.com" style="color:#2E6B52;text-decoration:none;">hello@salonvine.com</a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 40px 28px 40px;border-top:1px solid #EDEAE4;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:19px;color:#9A958B;">
            SalonVine &middot; {{ADDRESS}}<br>
            You&rsquo;re getting this because you run a salon. <a href="{{UNSUB}}" style="color:#9A958B;text-decoration:underline;">Unsubscribe</a> and I won&rsquo;t write again.
          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>
`;

export const TEXT = `Hello,

SalonVine gives your salon its own website, an online calendar your
clients can book into at any hour, and a checkout that takes cards
right at the chair. You are never billed by the stylist — each plan
covers a team, and you only move up when you outgrow the one you're
on.

You get your own address, your menu, your prices, and every stylist
setting her own timing. Clients book from their phone at 11 at night.
Have a look: https://salonvine.com

WHY WE BUILT IT

My wife and I own a salon in mid-Michigan, so this started as our own
problem. We ran the shop on the big-name booking systems for years,
and two things never sat right: the bill went up every time somebody
new took a chair, and every time a client paid us, someone took a
slice on the way through.

So my business partner and I built what we actually wanted. He writes
the software, I use it in my salon every day, and when something is
clumsy at the chair it gets fixed that week.

That second part is where most of the money goes. Here's what five
people on the books costs each month:

  SalonVine Studio Pro (team of 10) ........... $39
  Square Appointments Plus .................... $49
  GlossGenius Gold ............................ $56
  Vagaro ($30 + $10 a calendar) ............... $70
  Booksy Biz ($29.99 + $20 a stylist) ......... $109.99

  Everyone's published month-to-month rates, September 2026. A few
  are cheaper if you pay a year up front.

Our three plans: Studio $19 for a team of three, Studio Pro $39 for a
team of ten, and Studio Elite $59 with no limit at all. Move between
them whenever you like.

THREE THINGS I'D WANT TO KNOW IF I WERE YOU

  Nobody bills you by the chair. Studio Pro covers ten people for $39.
  Hire your fourth stylist, or your ninth, and the invoice looks
  exactly the same as it did the month before.

  We never touch your money. Deposits and checkouts go straight into
  your own Stripe account. We don't take a percentage of your bookings
  and we don't take a cut of your sales. Not now, not later.

  Booth renters keep their own books. A chair renter can hook up her
  own Stripe and take her own payments, while your commission girls
  run through yours. We needed that ourselves, and nothing else did it
  properly.

It takes about ten minutes to set up. Salon name, your services, your
team — and your site is live. If you're already on something else,
send us your client list and your calendar and we'll move it over for
you. You don't have to retype a thing.

The first 30 days are free. No setup fee, no contract, and nobody to
argue with on the phone if you want out. Cancel before day 31 and
you're never charged a cent.

Try it free for 30 days: https://salonvine.com

Or just hit reply and tell me what you're using now — I'm happy to
tell you straight whether we'd actually be an upgrade for you. Some
salons are better off where they are, and I'll say so.

Dylan Haller
Co-founder, SalonVine — and a salon owner, same as you
hello@salonvine.com

------------------------------------------------------------
SalonVine · {{ADDRESS}}
You're getting this because you run a salon.
Unsubscribe: {{UNSUB}}
`;
