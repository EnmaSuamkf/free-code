
import os
import json
import yaml
from pathlib import Path

# Fix for yaml loading user path
from yaml.loader import SafeLoader


def discover_agents(search_path="~/.free-code/agents"):
    """
    Discovers agents defined in AGENT.md files within a given directory,
    parses their YAML frontmatter, and returns a list of agent metadata.
    """
    agents_path = Path(search_path).expanduser()
    agent_manifests = agents_path.glob("**/AGENT.md")

    discovered_agents = []

    for manifest_path in agent_manifests:
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                content = f.read()
            
            # Split the frontmatter from the markdown body
            parts = content.split('---')
            if len(parts) >= 3:
                frontmatter_str = parts[1]
                agent_data = yaml.load(frontmatter_str, Loader=SafeLoader)
                
                # Include the path to the agent file for later use
                agent_data['path'] = str(manifest_path)
                discovered_agents.append(agent_data)
        except (IOError, yaml.YAMLError) as e:
            print(f"Error processing file {manifest_path}: {e}")

    return discovered_agents

if __name__ == "__main__":
    agents = discover_agents()
    print(json.dumps(agents, indent=2))

