---
title: "Account and sign-in"
description: "Sign in with Google, email or a wallet, then finish setup and confirm your vAPI ID."
order: 5
---

Select Sign in at [api.vapinetwork.ai](https://api.vapinetwork.ai), then choose Google, email or a wallet.
A new email or Google login creates an account; an existing sign-in email opens its account.
Each account has one wallet, and every sign-in method opens that same account.
Accounts do not merge.

## Sign in

The first window offers Continue with Google, Continue with email and Connect a wallet.
Connect a wallet opens a separate picker for supported and installed wallets.
Cancelling the picker returns you to the first screen.

| Method | What happens                                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| Google | Continue with Google opens Google sign-in. Some identities need an email code to finish connecting Google.     |
| Email  | Enter the six-digit code sent to your email. Send a new code becomes available after 30 seconds.               |
| Wallet | Review the sign-in message, then select Sign in with wallet. This needs one free signature and moves no money. |

New email and Google accounts receive Your vAPI wallet, an embedded EVM wallet kept by Coinbase.
This differs from the Coinbase Wallet entry in the wallet picker, which can create a smart wallet.
Email and Google login do not require that embedded wallet to sign a wallet sign-in message.
vAPI offers no password sign-in.

Email and Google prepare a security check while the initial screen is visible and online, when configured.
The inline check asks for interaction only when needed; wallet sign-in runs its check on demand.
If a new-account check appears, choose whether to create another account or return to the remembered one.

## Account setup

Finish the missing steps in this order: picture, safety word, username.
Saved answers are reused, including a Genesis Egg holder's existing safety word.
Required setup cannot be dismissed with Escape, the backdrop or Close; Sign out or Disconnect remains available.
Draft answers survive reload in the same wallet's tab storage when browser storage is available.

| Step        | What you choose                                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Picture     | Choose one of three generated variants. You can change it later.                                                                                                                                                                              |
| Safety word | Type your own word or phrase, or select Suggest one. Use 4 to 32 characters: letters and numbers, with single spaces or hyphens between words. You cannot change it after saving.                                                             |
| Username    | Use 3 to 20 lowercase letters, numbers or underscores, including at least one letter or digit. Reserved names and generated patterns can fail, including vapi followed by your wallet's last four hex characters. You cannot change it later. |

The final action is Create your vAPI ID.
Saving setup and confirming the ID are separate operations; the waiting window remains until your account is ready.
Done shows Account as Created, Username as Saved and the vAPI ID status, followed by Start exploring.
Its folded Give this to your agent section contains a copyable prompt with your username.

Your safety word helps you recognise vAPI screens and emails.
The account menu displays it directly when you are signed in and it is present.
Some genuine email-change and removal notices omit it, so it is a recognition aid rather than a universal authenticity test.
vAPI never asks you to type or send your saved safety word, seed phrase or private key.

## Join verification and your vAPI ID

New accounts need one accepted verification signal before vAPI sponsors the ID mint on Base.
The checklist adds Prove you're a person when verification is needed.
These paths are alternatives; you can authenticate before you qualify for the sponsored mint.

| Signal      | What qualifies                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Google      | Recorded Google signup or trusted linked-Google evidence. The checklist button explains how to add email, then sign in with Google using that address. |
| Email       | A real sign-in email that passes the shared domain checks. Adding it requires code verification.                                                       |
| Router      | A recorded credited top-up. The verification page offers Top up $1 on Router; return to the sign-in window afterward.                                  |
| Used wallet | At least one sent transaction on Base, Ethereum, BSC, Optimism or Arbitrum One. Receiving tokens alone does not qualify.                               |
| Existing ID | A previously confirmed or existing onchain vAPI ID.                                                                                                    |

Valid custom-domain email addresses are eligible; vAPI does not restrict signup to a finite provider list or check MX records.
Email identity ignores case and surrounding spaces; Gmail dots, plus suffixes and googlemail.com map to the same identity.
New throwaway-email accounts are refused, while an existing account holding that email can still sign in.
Addresses from these privacy-relay services are accepted, including their subdomains.

| Relay                  | Accepted domains                                       |
| ---------------------- | ------------------------------------------------------ |
| DuckDuckGo and Firefox | duck.com, mozmail.com                                  |
| Addy                   | addy.io, anonaddy.com, anonaddy.me                     |
| SimpleLogin            | simplelogin.com, simplelogin.co, aleeas.com, slmail.me |
| Proton                 | passmail.net, passmail.com, passinbox.com              |
| Apple                  | privaterelay.appleid.com                               |

## Waiting for your vAPI ID

The waiting checklist shows Account, Username and vAPI ID, plus verification when needed.
ID labels include Waiting, On Base, Creating…, Delayed, Checking… and On hold.

| State               | What it means                                            | What you do                                                 |
| ------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| Verification needed | One accepted signal is still missing.                    | Choose a verification path, then return.                    |
| Creating            | vAPI is writing your ID to Base.                         | Wait for confirmation.                                      |
| Slow                | Confirmation is taking longer than usual.                | Let the screen update; View transaction may be available.   |
| Delayed             | vAPI's team has been alerted to a problem on its side.   | You can close the page and return; use Discord for help.    |
| Cannot check        | Your ID may already exist, but vAPI cannot check it now. | The screen retries every few seconds; use Discord for help. |
| On hold             | The mint needs support intervention.                     | Ask on Discord to continue.                                 |
| Ready               | Your vAPI ID is ready.                                   | Select Continue.                                            |

Delayed, cannot-check and on-hold states offer [Get help on Discord](https://discord.gg/vapinetwork).
Pending states retain Sign out; automatic polling does not remove verification or hold requirements.
Readiness requires completed setup, a valid picture and username, and a recorded ID confirmation.
Without readiness, guarded product APIs, agent linking, OAuth consent and owner-bound credential issuance remain unavailable.

Account read/setup and own-ID read, mint and polling remain available during recovery.
A setup-complete pending account can also add or verify an own-wallet sign-in email and use the $1 verification top-up.
These exceptions do not admit machine credentials or bypass required setup; email removal still requires readiness.
Public unauthenticated reads and independent buyer-local x402 payments do not acquire an ID requirement.
The signed-in console nevertheless keeps pending accounts in the waiting window.
The ID cannot be transferred and grants no token rights by itself.
It establishes no skill, history or reviewer eligibility.

## Account menu and navigation

Open the account menu from the avatar and username in the header, with Account as its fallback.
The menu truncates USDC balances to two decimal places.
A signed-in account without its wallet gets Connect wallet; signed-out visitors get Sign in.

| Order          | Own-wallet account                                                                           | Active vAPI-wallet account                                                                        |
| -------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1              | Avatar, username or wallet-name fallback, shortened address, Copy address and explorer link. | Avatar, username or Your vAPI account fallback, embedded address, Copy address and explorer link. |
| 2              | Balance, then Network and Wallet.                                                            | Balance, then the Coinbase custody notice, Network and Your vAPI wallet.                          |
| 3, conditional | Connect wallet when signed in without the wallet; otherwise Sign in when needed.             | The same conditional connection action.                                                           |
| 4, signed in   | Safety word, when present.                                                                   | Signed in as with your email, then Safety word.                                                   |
| 5              | Theme, showing Dark or Light.                                                                | Theme, showing Dark or Light.                                                                     |
| 6              | Switch wallet, then Disconnect.                                                              | Add funds, Export key, Switch wallet, Disconnect.                                                 |

The vAPI-wallet custody notice says Coinbase keeps the wallet and vAPI cannot move your funds.
Account links are hidden inside this dropdown; use the separate Account navigation in the sidebar, tabs or mobile menu.
Settings opens the account dialog, followed by My APIs, My agents and Usage and activity in this order.

| Order | Account navigation | Destination     |
| ----- | ------------------ | --------------- |
| 1     | Settings           | Account dialog  |
| 2     | My APIs            | `/call/my-apis` |
| 3     | My agents          | `/agents`       |
| 4     | Usage and activity | `/usage`        |

## Settings and wallet proof

Sign-in methods follows the safety word in Settings.
Adding email to an own-wallet account opens the same account and does not merge accounts.
An email already used elsewhere remains unavailable after successful code verification.

| Setting           | What you can do                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Own-wallet email  | Add, change or remove email. Add/change requires a verified code and wallet proof, including the first email.                                      |
| Google            | With a real email, see Connected or guidance to use Continue with Google with that email. There is no separate Google connect/remove control here. |
| vAPI-wallet email | Read-only; this email opens your vAPI wallet and cannot be changed yet.                                                                            |
| Wallet            | Copy its address and, when available, choose Use it in your own wallet app. This section does not replace or remove the account wallet.            |

Removing email also clears Google sign-in; the original wallet remains bound to the account.
Changing or removing email stops admission through the old address and attempts to sign out other sessions.
The caller's wallet-proved session remains active.
Reading an own-wallet account through email or Google does not itself require reconnecting the browser wallet.

Sensitive actions require proof from the account wallet when that own-wallet account has or ever had sign-in email.
The prompt asks you to connect the matching address, switch wallets, cancel or sign out, then review wallet sign-in.
Cancellation does not retry the action; successful recovery can retry a reusable request once.
A matching trusted embedded credential satisfies proof without an external wallet sign-in signature.

## Your vAPI wallet

Every embedded signature opens a review sheet with account, network and payment, approval, message or transaction details.
Unknown or unreadable requests cannot be confirmed.
Embedded Call and Router x402 authorizations work, but the embedded connector cannot pay network fees yet.
Stake transactions, Egg mints and direct wallet transfers require an external wallet connection.

Add funds opens the wallet's funding page with Buy with card, Send from your wallet and Bridge from another chain.
You can also send Base USDC manually; direct sending from another embedded connector is disabled.
Card availability can vary, and a blocked popup offers Open Coinbase in a new tab.
Insufficient USDC for the matching embedded payer can offer Add funds from a Call or Router payment failure.

Export key warns that anyone holding the private key can take your funds.
Show export opens Coinbase's export frame, with Cancel and Close export available; never share the key.
You can import it into MetaMask, Rabby or Coinbase Wallet, then sign in with that wallet.
Signatures then use the active external wallet connector.

Checked on 2026-11-17.
