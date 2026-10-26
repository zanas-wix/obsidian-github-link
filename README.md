# GitHub Link

[![Wiki Badge](https://img.shields.io/badge/wiki-documentation-blue?logo=github)](https://github.com/nathonius/obsidian-github-link/wiki)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=nathonius_obsidian-github-link&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=nathonius_obsidian-github-link) [![All Contributors](https://img.shields.io/github/all-contributors/nathonius/obsidian-github-link?color=ee8449)](#contributors)

**Obsidian + GitHub ❤️**

Inject rich content from GitHub into your notes:

- GitHub links are transformed into tags showing issue and pull request titles, statuses, etc
- Use codeblocks to keep an up-to-date table of GitHub data inside a note

## Use

### Links

Github links are automatically transformed into tags. For example, pasting `https://github.com/nathonius/obsidian-github-link/issues/1` into a note will become:

![ExampleTag](doc/ExampleInlineTag.png)

### Table

You can also include a table with results from a search query using a `github-query` codeblock. For example:

````
```github-query
outputType: table
queryType: pull-request
query: "is:pr repo:nathonius/obsidian-github-link"
columns: [number, title, author, status]
```
````

This produces a table of results that refreshes upon opening the note.

![ExampleTable](doc/ExampleQueryResult.png)

For `pull-request` queries, add `stack: true` to group PRs that are stacked on each other (a PR whose base branch is another PR's head branch). Each stack is listed together, bottom PR first, and a `stack` column shows the position (e.g. `2/3`). Stacks are detected within the current page of results only, and search queries fetch each PR to read its branches.

Use `outputType: cards` instead of `table` for a card layout. Each card shows the title as a link, with status, number, repo and stack position in its header and the remaining `columns` (author, created, labels, ...) below. With `stack: true`, a stack's cards sit together in one container, indented by position. In cards view a dropdown above the list groups the pull requests: none, by repo, by status (open, draft, merged, closed), by author, by last update (today, this week, this month, older) or by merge readiness (ready to merge, needs review, CI running, CI failing, changes requested, conflicts, draft). `groupBy: repo|status|author|updated|readiness` sets the starting grouping; the choice made with the dropdown is remembered per block until Obsidian restarts.

Queries may use `OR`, with parentheses to group: `query: "is:pr is:open (author:me OR assignee:me)"`. GitHub's search can't do this across qualifiers, so the plugin splits the query into plain searches, runs each (all pages), and merges the results without duplicates. `AND` binds tighter than `OR`, as on GitHub, so without parentheses `is:pr author:me OR assignee:me` means `(is:pr author:me) OR assignee:me`. Merged results are not paginated.

For `pull-request` queries, the columns `review` (approved / changes requested / review required), `ci` (checks passed/total, coloured by the overall result) and `merge` (shows "Conflicts" only when there are some) show whether a PR is ready to merge. `lines` shows the total lines added and removed, like `+1251/-480`; it comes from the same request, so it costs nothing extra. Add them to `columns`, e.g. `columns: [number, title, review, ci, merge]`. They are loaded in batches with a single GraphQL request per 25 PRs, which needs a token (an account token or the gh CLI). In cards they appear on the right of each card. Add `statusRefresh: 60` to re-check them every 60 seconds (minimum 30): one batched request per 25 open PRs, paused while the window is hidden, and backing off after failures. Each card also has a refresh icon for a single PR.

### Pull request pane

In cards view, click a pull request card (anywhere except a link or button) to open it in a side pane; the pane follows whichever card you click, and the command "Open pull request pane" reveals it. It shows, from a single GraphQL request:

- a merge-readiness checklist (draft, review decision, checks, conflicts, behind base, unresolved conversations)
- the PR's stack, with one click to jump between its PRs and a button to copy the stack as a Markdown list
- reviewers and requested reviewers, all checks (failing first, linking to their details), and the description
- the conversation: comments, reviews and inline review threads with the code they refer to, resolved threads collapsed, and an "only unresolved" filter
- changed files with a +/- bar

The bell button watches a PR: you get a desktop notification when its CI turns green, when it is approved (each with what is still outstanding), and when it can be merged, which ends the watch. Watches are saved and checked in the background at a pace set by what the PRs are doing: every 20s while CI runs or the merge state is being computed, every minute while waiting on a reviewer, every 3 minutes while stuck (draft, failing CI, changes requested), and doubling after failed requests. The pane and `notify`/`statusRefresh` list footers show live countdowns to the next check. Add `notify: true` to a pull-request query block to watch every open PR it shows by default; the bell then mutes a single PR (and turns it back on). PRs already green or approved when first seen are not announced, only later changes.

Buttons copy the PR as a Markdown link, open it on GitHub, or refresh it. A visible pane re-checks its PR every minute.

### Custom groups

List specific pull requests, across repos, under names of your own, e.g. everything for one feature:

````
```github-query
outputType: cards
queryType: pull-request
columns: [number, title, review, ci, stack]
stack: true
groups:
  - name: Pages v2
    prs:
      - wix-private/ricos#10777
      - wix-private/ricos#10778
      - https://github.com/wix-private/ricos/pull/10779
  - name: Blog
    prs: [wix-private/app-market#61786]
```
````

A pull request is `org/repo#123` or its URL. Listed PRs are shown even if the block's `query` does not return them, so a block may have no `query` at all; ones the query returns anyway are not fetched twice. Groups appear in the order written and PRs inside them in the order listed; a stack stays together at its earliest listed member. PRs the query returns that no group lists go under "Other". A PR listed in several groups stays in the first. A reference that is malformed fails the block with a message naming it; one GitHub cannot return (no such PR, or no access) is reported above the list. With groups defined they are always the top level, and the grouping dropdown (relabelled "Then by …") splits each of them further: by repo, status, author, last update or merge readiness. `groupBy: repo` sets that starting sub-grouping.

See the [documentation](https://github.com/nathonius/obsidian-github-link/wiki) for more info.

## Updates

This project adheres to [semantic versioning](https://semver.org/). See the project [changelog](CHANGELOG.md) for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for info on contributing to the project.

### Contributors

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="http://nathan-smith.org"><img src="https://avatars.githubusercontent.com/u/4851889?v=4?s=100" width="100px;" alt="Nathan"/><br /><sub><b>Nathan</b></sub></a><br /><a href="#code-nathonius" title="Code">💻</a> <a href="#doc-nathonius" title="Documentation">📖</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://arongriffis.com"><img src="https://avatars.githubusercontent.com/u/50637?v=4?s=100" width="100px;" alt="Aron Griffis"/><br /><sub><b>Aron Griffis</b></sub></a><br /><a href="#code-agriffis" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/nikclayton"><img src="https://avatars.githubusercontent.com/u/773100?v=4?s=100" width="100px;" alt="Nik Clayton"/><br /><sub><b>Nik Clayton</b></sub></a><br /><a href="#bug-nikclayton" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://tech.dreamleaves.org"><img src="https://avatars.githubusercontent.com/u/1074760?v=4?s=100" width="100px;" alt="Arnaud 'red' Rouyer"/><br /><sub><b>Arnaud 'red' Rouyer</b></sub></a><br /><a href="#code-joshleaves" title="Code">💻</a> <a href="#test-joshleaves" title="Tests">⚠️</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://macwright.com/"><img src="https://avatars.githubusercontent.com/u/32314?v=4?s=100" width="100px;" alt="Tom MacWright"/><br /><sub><b>Tom MacWright</b></sub></a><br /><a href="#code-tmcw" title="Code">💻</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->
