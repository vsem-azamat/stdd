# Terms of use

These terms cover the STDD command-line tool, the STDD plugin distribution, and
the published packages `@stdd/cli` and `@stdd/plugin`. Installing or using any
of them means accepting what is written here.

## The licence is the agreement

STDD is released under the MIT License, in the `LICENSE` file at the root of
this repository. That licence grants the permissions and states the warranty
disclaimer; nothing on this page narrows it. Where this page and the licence
disagree, the licence wins.

## No service, no account, no data

There is nothing to sign up for. STDD runs on your machine, ships no telemetry,
and contacts no service operated by its author. The author operates no server
on your behalf, holds no account for you, and receives no data from your use of
the tool. `PRIVACY.md` states this in detail and names the exceptions —
principally that a command you hand to `stdd red` or `stdd verify` runs
unmodified, and a CI job you write runs under your own credentials.

Because there is no service, there is no uptime commitment, no support
obligation, and no notice period. Releases happen when they happen, and any
version may change or remove behavior; the version you have installed keeps
working exactly as it did.

## Provided as is

The software is provided "as is", without warranty of any kind, express or
implied, including but not limited to the warranties of merchantability,
fitness for a particular purpose, and non-infringement. To the extent permitted
by applicable law, the author is not liable for any claim, damages, or other
liability arising from the software or its use.

## Your repository is yours, and so is what the agents do in it

STDD is a method and a set of checks for AI coding agents. It records evidence,
grades claims against a diff, and refuses claims it cannot verify. It does not
write your code, and it cannot make an agent correct.

You are responsible for what the agents you run do in your repository, for
reviewing their changes before you merge or deploy them, and for the
consequences of shipping them. A green `stdd check` means the checks it
performs passed — nothing more. Keep backups and use version control; STDD's
own commands create, modify, and delete files in the directories you point them
at.

You are also responsible for complying with the terms of the agent CLIs,
models, and services you use STDD with. STDD is not affiliated with, endorsed
by, or acting on behalf of any of them.

## Trademarks and third-party names

Names of other products and services mentioned in this repository belong to
their respective owners and are used only to describe compatibility.

## Changes

These terms may change between releases. The version that applies is the one
published with the release you are using; the history is in this repository's
Git log.

## Contact

Questions and reports: <https://github.com/vsem-azamat/stdd/issues>
