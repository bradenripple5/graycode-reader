_basic_fiducial_reader()
{
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  local opts="
    --camera
    --cameras
    --max-camera-index
    --width
    --height
    --fps
    --process-fps
    --downscale
    --color-line-reader
    --color-line-crop
    --color-line-radial
    --robust-color
    --tile-width
    --expected-pairs
    --threshold
    --exposure
    --gain
    --brightness
    --contrast
    --print-every
    --use-threshold
    --auto-threshold
    --best-threshold
    --ring-fit
    --no-window
    --separate-windows
    --angle-line
    --angle-csv
    --tcp-port
    --udp-port
    --udp-target
    --help
    -h
  "

  case "$prev" in
    --camera|--max-camera-index|--width|--height|--downscale|--color-line-crop|--tile-width|--expected-pairs|--threshold|--print-every|--tcp-port|--udp-port)
      COMPREPLY=($(compgen -W "0 1 2 3 4 5 6 7 8 9 10 12 16 20 30 34 60 120 240 480 640 720 960 1280" -- "$cur"))
      return
      ;;
    --fps|--process-fps)
      COMPREPLY=($(compgen -W "0 1 5 10 15 20 30 60" -- "$cur"))
      return
      ;;
    --exposure|--gain|--brightness|--contrast)
      COMPREPLY=()
      return
      ;;
    --cameras)
      COMPREPLY=($(compgen -W "0 0,1 0,1,2 0,1,2,3" -- "$cur"))
      return
      ;;
    --udp-target)
      COMPREPLY=($(compgen -W "127.0.0.1:5001 127.0.0.1:6001" -- "$cur"))
      return
      ;;
  esac

  if [[ "$cur" == --* || -z "$cur" ]]; then
    COMPREPLY=($(compgen -W "$opts" -- "$cur"))
    return
  fi

  COMPREPLY=()
}

complete -F _basic_fiducial_reader basic_fiducial_reader
