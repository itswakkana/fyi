export function bodyTemplate(type, title) {
  switch (type) {
    case 'pattern':
      return `# ${title}

## When to use

<!-- A concrete symptom or task, e.g. "a request 500s in api and you need the full trace". -->

## Prerequisites

- Access to:
- Tools:

## Steps

1.

## Commands

\`\`\`bash
# Replace <placeholders> before running.
\`\`\`

## Expected signals

<!-- What proves you found the right thing: log lines, fields, IDs, status codes. -->

## Gotchas

-

## Related

-
`;
    case 'knowledge':
      return `# ${title}

## Summary

## Facts

-

## Implications

<!-- What should change in code, review, or operations because of these facts? -->

## Sources

<!-- Links, dashboards, tickets, or people who confirmed this. -->

## Open questions

- [ ]
`;
    case 'runbook':
      return `# ${title}

## Trigger

## Preconditions

- [ ]

## Steps

1.

## Verify

## Rollback

## Escalation

- Owner:
- Channel:
`;
    case 'doc':
      return `# ${title}

## Summary

## Key points

-

## Source

## Related

-
`;
    default:
      return `# ${title}\n`;
  }
}

export function scriptTemplate(title, targetPath, ext) {
  const zsh = ext === '.zsh';
  const shell = ['.sh', '.bash', '.zsh'].includes(ext);
  const python = ext === '.py';
  const ruby = ext === '.rb';
  const safeTitle = String(title).replace(/\s+/g, ' ').trim();
  const run = zsh
    ? `zsh ${targetPath}`
    : shell
      ? `bash ${targetPath}`
      : python
        ? `python3 ${targetPath}`
        : ruby
          ? `ruby ${targetPath}`
          : `node ${targetPath}`;

  if (shell) {
    return `#!/usr/bin/env ${zsh ? 'zsh' : 'bash'}
${zsh ? '' : 'set -euo pipefail\n'}
# ${safeTitle}
#
# Usage:
#   ${run} [args]
#
# What it does:
#   TODO
#
# Output:
#   TODO

# TODO: implement
`;
  }

  if (python) {
    return `#!/usr/bin/env python3
# ${safeTitle}
#
# Usage:
#   ${run} [args]
#
# What it does:
#   TODO
#
# Output:
#   TODO

# TODO: implement
`;
  }

  if (ruby) {
    return `#!/usr/bin/env ruby
# ${safeTitle}
#
# Usage:
#   ${run} [args]
#
# What it does:
#   TODO
#
# Output:
#   TODO

# TODO: implement
`;
  }

  return `// ${safeTitle}
//
// Usage:
//   ${run} [args]
//
// What it does:
//   TODO
//
// Output:
//   TODO

// TODO: implement
`;
}

export function appOverview(app, date) {
  return {
    frontmatter: {
      type: 'knowledge',
      title: `${app.name} overview`,
      description: `What ${app.name} is, what it owns, and how it fits.`,
      apps: [app.name],
      tags: ['overview'],
      owner: '',
      status: 'draft',
      updated: date,
      related: [],
    },
    body: `# ${app.name} overview

## What it is

TODO: one paragraph a new developer can understand.

## Owns

-

## Depends on

-

## Entry points

- Path:
- Dev command:
- Deploy target:

## Open questions

- [ ] Confirm the owner of this app.
`,
  };
}
