# Feature Specification Template

Use this structure when generating `/analysis/spec-{issue_key}.md`.

## Required Sections

### Metadata (top of file)

### Target Modules

Search workspace (Cursor/VS Code) or project (IntelliJ) for module(s) the feature touches. List paths or package names. If none found: "To be determined during implementation".

_Example:_

- `src/modules/user-management/`
- `com.example.app.usermanagement`

### User Scenarios & Testing

Each User Story must include:

- **User Story N - [Brief Title] (Priority: P1|P2|P3)**
- **Why this priority**: [Explain value]
- **Independent Test**: [How to test independently]
- **Acceptance Scenarios**: **Given** [state], **When** [action], **Then** [outcome]

### Edge Cases

- What happens when [boundary condition]?
- How does system handle [error scenario]?

### Functional Requirements

Format: **FR-NNN**: System MUST [capability] or Users MUST be able to [interaction]

For unclear requirements, mark: [NEEDS CLARIFICATION: what is missing]

### Key Entities (if feature involves data)

Format: **[Entity name]**: [What it represents, key attributes, relationships]

### Security Vibe Check

Identify:

- Buffer bounds, overflow, or truncation risks
- Authentication and authorization edge cases
- Input validation and sanitization gaps
- PII, financial logic, or sensitive data handling

Document at least 2 non-obvious security considerations.

### Success Criteria / Measurable Outcomes

Format: **SC-NNN**: [Measurable metric, technology-agnostic]

_Example:_ **SC-001**: Users can complete X in under Y minutes

## After Generating Spec

Jira Labels Steps section, spec step: `bot-cx-ai-spec`.
