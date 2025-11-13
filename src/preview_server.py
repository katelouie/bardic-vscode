#!/usr/bin/env python3
"""
Preview server for Bardic VSCode extension.

This script runs as a subprocess and handles passage preview requests.
It maintains a BardEngine instance and responds to commands via stdin/stdout.
"""

import json
import sys
from typing import Any, Dict

try:
    from bardic.runtime.engine import BardEngine
except ImportError:
    # If bardic not installed, exit with helpful error
    print(json.dumps({
        "error": "Bardic not installed",
        "message": "Please install bardic: pip install bardic"
    }))
    sys.exit(1)


def serialize_output(output) -> Dict[str, Any]:
    """
    Serialize PassageOutput to JSON-friendly dict.

    Args:
        output: PassageOutput from engine

    Returns:
        Dictionary with content, choices, and passage_id
    """
    return {
        "content": output.content,
        "choices": output.choices,
        "passage_id": output.passage_id,
        "has_choices": len(output.choices) > 0
    }


def main():
    """Main preview server loop."""
    try:
        # Read story data from first line of stdin
        story_line = sys.stdin.readline()
        if not story_line:
            print(json.dumps({"error": "No story data provided"}), flush=True)
            sys.exit(1)

        try:
            story_data = json.loads(story_line)
        except json.JSONDecodeError as e:
            print(json.dumps({
                "error": "Invalid story JSON",
                "message": str(e)
            }), flush=True)
            sys.exit(1)

        # Initialize engine with story
        try:
            engine = BardEngine(story_data)
        except Exception as e:
            import traceback
            print(json.dumps({
                "error": "Engine initialization failed",
                "message": str(e),
                "traceback": traceback.format_exc()
            }), flush=True)
            sys.exit(1)

        # Send ready signal
        print(json.dumps({"status": "ready"}), flush=True)

        # Process commands
        while True:
            line = sys.stdin.readline()
            if not line:
                break

            try:
                command = json.loads(line)
                command_type = command.get("type")

                if command_type == "preview":
                    # Preview a passage with provided state
                    passage_id = command.get("passage")
                    user_state = command.get("state", {})

                    if not passage_id:
                        print(json.dumps({
                            "error": "Missing passage ID"
                        }), flush=True)
                        continue

                    # Update engine state with user-provided values
                    engine.state.update(user_state)

                    # Navigate to passage
                    try:
                        output = engine.goto(passage_id)
                        result = serialize_output(output)
                        print(json.dumps(result), flush=True)
                    except Exception as e:
                        print(json.dumps({
                            "error": "Engine error",
                            "message": str(e)
                        }), flush=True)

                elif command_type == "choice":
                    # Make a choice and navigate
                    choice_index = command.get("index")

                    if choice_index is None:
                        print(json.dumps({
                            "error": "Missing choice index"
                        }), flush=True)
                        continue

                    try:
                        output = engine.choose(choice_index)
                        result = serialize_output(output)
                        print(json.dumps(result), flush=True)
                    except Exception as e:
                        print(json.dumps({
                            "error": "Choice error",
                            "message": str(e)
                        }), flush=True)

                elif command_type == "current":
                    # Get current passage without navigation
                    try:
                        output = engine.current()
                        result = serialize_output(output)
                        print(json.dumps(result), flush=True)
                    except Exception as e:
                        print(json.dumps({
                            "error": "Engine error",
                            "message": str(e)
                        }), flush=True)

                elif command_type == "exit":
                    break

                else:
                    print(json.dumps({
                        "error": "Unknown command type",
                        "type": command_type
                    }), flush=True)

            except json.JSONDecodeError as e:
                print(json.dumps({
                    "error": "Invalid JSON",
                    "message": str(e)
                }), flush=True)
            except Exception as e:
                print(json.dumps({
                    "error": "Unexpected error",
                    "message": str(e)
                }), flush=True)

    except Exception as e:
        print(json.dumps({
            "error": "Fatal error",
            "message": str(e)
        }), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
