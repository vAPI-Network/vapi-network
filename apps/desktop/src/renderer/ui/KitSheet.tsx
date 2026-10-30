// apps/desktop/src/renderer/ui/KitSheet.tsx
/**
 * The printed Emergency Kit (spec §4, §8; no QR). Hidden on screen; the print rules in styles.css
 * show only this sheet when the macOS print dialog runs.
 */
export function KitSheet({
  words,
  wallets,
  date,
}: {
  words: readonly string[];
  wallets: readonly { name: string; address: string }[];
  date: string;
}) {
  return (
    <section className="kit-print" aria-hidden>
      <h1>vAPI Desktop: Emergency Kit</h1>
      <p>Made on {date}. Keep this paper somewhere safe and offline.</p>
      <ol className="kit-words">
        {words.map((word, index) => (
          <li key={index}>
            <span>{index + 1}.</span> {word}
          </li>
        ))}
      </ol>
      <h2>Anyone with these words can take the money.</h2>
      <p>
        vAPI cannot see these words and cannot reset them. Never type them into a website or a chat.
      </p>
      <h2>What these words bring back</h2>
      <p>
        Every agent wallet made in vAPI Desktop on this Mac, with its money. Wallet names, limits
        and app connections are not in this kit: after a restore the wallets are called account-1,
        account-2 and so on, with the standard limits, and you connect them again.
      </p>
      {wallets.length > 0 && (
        <table>
          <tbody>
            {wallets.map((wallet) => (
              <tr key={wallet.address}>
                <td>{wallet.name}</td>
                <td>{wallet.address}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>How to restore</h2>
      <p>
        Install vAPI Desktop, choose “Restore from Emergency Kit” on the first screen, type the
        words in order and choose a new password.
      </p>
    </section>
  );
}
